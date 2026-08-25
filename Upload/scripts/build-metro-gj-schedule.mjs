import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, 'data', 'metro-gj-schedule.json');
const metroBusGtfsUrl = 'https://gitlab.com/LACMTA/gtfs_bus/raw/master/gtfs_bus.zip';
const routeWhitelist = new Set(['g', 'j', '901', '910', '950']);

function findZipEndOfCentralDirectory(buffer) {
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66000); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw new Error('GTFS zip directory was not found');
}

function extractZipEntries(buffer, wantedNames) {
  const wanted = new Set(wantedNames);
  const entries = {};
  const directoryOffset = findZipEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(directoryOffset + 10);
  let pointer = buffer.readUInt32LE(directoryOffset + 16);

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex++) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('Invalid GTFS zip central directory');

    const compressionMethod = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const fileNameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localHeaderOffset = buffer.readUInt32LE(pointer + 42);
    const fileName = buffer.toString('utf8', pointer + 46, pointer + 46 + fileNameLength).replace(/^.*\//, '');

    if (wanted.has(fileName)) {
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error(`Invalid GTFS zip entry: ${fileName}`);
      const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
      const data = compressionMethod === 0
        ? compressedData
        : compressionMethod === 8
          ? inflateRawSync(compressedData)
          : null;

      if (!data) throw new Error(`Unsupported GTFS zip compression for ${fileName}`);
      entries[fileName] = data.toString('utf8');
    }

    pointer += 46 + fileNameLength + extraLength + commentLength;
  }

  for (const name of wanted) {
    if (!entries[name]) throw new Error(`GTFS file missing from zip: ${name}`);
  }

  return entries;
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }

  values.push(value);
  return values;
}

function forEachCsvRecord(text, onRecord) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) return;
  const headers = parseCsvLine(lines[0]);
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const values = parseCsvLine(lines[lineIndex]);
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });
    onRecord(record);
  }
}

function normalizeStopKey(value) {
  return String(value || '').trim().replace(/S$/i, '');
}

function gtfsTimeToSeconds(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

function addStopIndexEntry(index, stopId, entry) {
  const keys = new Set([String(stopId || '').trim(), normalizeStopKey(stopId)]);
  keys.forEach((key) => {
    if (!key) return;
    if (!index[key]) index[key] = [];
    index[key].push(entry);
  });
}

function routeIsGj(route) {
  return [
    route.route_short_name,
    route.route_id,
    route.route_long_name,
    route.route_desc
  ].map((value) => String(value || '').trim().toLowerCase()).some((value) => {
    if (!value) return false;
    if (routeWhitelist.has(value)) return true;
    if (/^(901|910|950)(?:\b|-)/.test(value)) return true;
    if (/\b(g|j)\s*line\b/.test(value)) return true;
    if (value.includes('orange line') || value.includes('silver line')) return true;
    return false;
  });
}

async function main() {
  console.log('Downloading LA Metro bus GTFS...');
  const response = await fetch(metroBusGtfsUrl, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Metro bus GTFS returned HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB. Extracting required GTFS files...`);
  const entries = extractZipEntries(buffer, [
    'stops.txt',
    'routes.txt',
    'trips.txt',
    'stop_times.txt',
    'calendar.txt',
    'calendar_dates.txt'
  ]);

  const routes = new Map();
  const gjRouteIds = new Set();
  forEachCsvRecord(entries['routes.txt'], (route) => {
    if (!routeIsGj(route)) return;
    gjRouteIds.add(route.route_id);
    routes.set(route.route_id, {
      id: route.route_id,
      shortName: route.route_short_name || route.route_id,
      longName: route.route_long_name || route.route_short_name || route.route_id
    });
  });

  const trips = new Map();
  const serviceIds = new Set();
  forEachCsvRecord(entries['trips.txt'], (trip) => {
    if (!gjRouteIds.has(trip.route_id)) return;
    const route = routes.get(trip.route_id) || { shortName: trip.route_id, longName: trip.route_id };
    serviceIds.add(trip.service_id);
    trips.set(trip.trip_id, {
      id: trip.trip_id,
      routeId: trip.route_id,
      serviceId: trip.service_id,
      directionId: trip.direction_id,
      headsign: trip.trip_headsign || '',
      routeShortName: route.shortName,
      routeLongName: route.longName
    });
  });

  const stopIdsUsed = new Set();
  const rawStopTimes = [];
  forEachCsvRecord(entries['stop_times.txt'], (stopTime) => {
    const trip = trips.get(stopTime.trip_id);
    if (!trip) return;
    const seconds = gtfsTimeToSeconds(stopTime.departure_time || stopTime.arrival_time);
    if (seconds === null) return;
    stopIdsUsed.add(stopTime.stop_id);
    rawStopTimes.push({ stopTime, trip, seconds });
  });

  const stopsById = new Map();
  const stopNameIndex = [];
  forEachCsvRecord(entries['stops.txt'], (stop) => {
    if (!stopIdsUsed.has(stop.stop_id) && !stopIdsUsed.has(normalizeStopKey(stop.stop_id))) return;
    const stopInfo = {
      id: stop.stop_id,
      name: stop.stop_name || stop.stop_id
    };
    stopsById.set(stop.stop_id, stopInfo);
    stopsById.set(normalizeStopKey(stop.stop_id), stopInfo);
    stopNameIndex.push(stopInfo);
  });

  const calendar = {};
  forEachCsvRecord(entries['calendar.txt'], (row) => {
    if (!serviceIds.has(row.service_id)) return;
    const days = [];
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((day) => {
      if (row[day] === '1') days.push(day);
    });
    calendar[row.service_id] = {
      days,
      startDate: row.start_date,
      endDate: row.end_date
    };
  });

  const calendarDates = {};
  forEachCsvRecord(entries['calendar_dates.txt'], (row) => {
    if (!serviceIds.has(row.service_id)) return;
    calendarDates[row.service_id + ':' + row.date] = row.exception_type;
  });

  const stopTimesByStop = {};
  rawStopTimes.forEach(({ stopTime, trip, seconds }) => {
    const stop = stopsById.get(stopTime.stop_id) || { id: stopTime.stop_id, name: stopTime.stop_id };
    const entry = {
      agency: 'metro',
      line: trip.routeShortName || trip.routeId,
      routeId: trip.routeId,
      destination: stopTime.stop_headsign || trip.headsign || trip.routeLongName || 'Scheduled bus',
      serviceId: trip.serviceId,
      directionId: trip.directionId,
      stopId: stop.id,
      stopName: stop.name,
      seconds
    };
    addStopIndexEntry(stopTimesByStop, stopTime.stop_id, entry);
  });

  const output = {
    agency: 'metro',
    label: 'LA Metro G/J',
    generatedAt: new Date().toISOString(),
    source: metroBusGtfsUrl,
    routes: Array.from(routes.values()),
    calendar,
    calendarDates,
    stopNameIndex,
    stopTimesByStop
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output));
  console.log(`Wrote ${outputPath}`);
  console.log(`Routes: ${routes.size}, trips: ${trips.size}, stops: ${stopNameIndex.length}, stop time entries: ${rawStopTimes.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
