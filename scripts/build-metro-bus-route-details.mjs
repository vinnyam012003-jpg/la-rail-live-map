import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outPath = join(root, 'data', 'metro-bus-route-details.json');
const gtfsUrl = process.env.METRO_BUS_GTFS_URL || 'https://gitlab.com/LACMTA/gtfs_bus/-/raw/master/gtfs_bus.zip';

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

function normalizeBusRouteKey(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function sequenceValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 999999;
}

function simplifyShapePoints(points, maxPoints = 700) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  const step = Math.ceil(points.length / maxPoints);
  const simplified = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  const simplifiedLast = simplified[simplified.length - 1];
  if (last && simplifiedLast && (last[0] !== simplifiedLast[0] || last[1] !== simplifiedLast[1])) simplified.push(last);
  return simplified;
}

function uniqueStopsFromTrips(rowsByDirection) {
  const orderedStopIds = [];
  Array.from(rowsByDirection.values()).forEach((rows) => {
    rows.sort((first, second) => first.sequence - second.sequence).forEach((row) => {
      if (!orderedStopIds.includes(row.stopId)) orderedStopIds.push(row.stopId);
    });
  });
  return orderedStopIds;
}

async function main() {
  console.log(`Downloading Metro Bus GTFS from ${gtfsUrl}`);
  const response = await fetch(gtfsUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`LA Metro Bus static GTFS returned HTTP ${response.status}`);

  console.log('Extracting needed GTFS tables');
  const entries = extractZipEntries(Buffer.from(await response.arrayBuffer()), [
    'routes.txt',
    'trips.txt',
    'stop_times.txt',
    'stops.txt',
    'shapes.txt'
  ]);

  const routeInfoById = new Map();
  forEachCsvRecord(entries['routes.txt'], (route) => {
    const shortName = route.route_short_name || route.route_id;
    if (!shortName) return;
    routeInfoById.set(route.route_id, {
      routeId: route.route_id,
      shortName,
      longName: route.route_long_name || shortName
    });
  });

  const tripsById = new Map();
  const routeShapeIds = new Map();
  forEachCsvRecord(entries['trips.txt'], (trip) => {
    if (!routeInfoById.has(trip.route_id)) return;
    tripsById.set(trip.trip_id, {
      routeId: trip.route_id,
      directionId: trip.direction_id || '',
      headsign: trip.trip_headsign || '',
      shapeId: trip.shape_id || ''
    });
    if (trip.shape_id) {
      if (!routeShapeIds.has(trip.route_id)) routeShapeIds.set(trip.route_id, new Set());
      routeShapeIds.get(trip.route_id).add(trip.shape_id);
    }
  });

  const stopsById = new Map();
  forEachCsvRecord(entries['stops.txt'], (stop) => {
    const lat = Number(stop.stop_lat);
    const lon = Number(stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    stopsById.set(stop.stop_id, {
      id: stop.stop_id,
      name: stop.stop_name || stop.stop_id,
      lat,
      lon
    });
  });

  const stopIdsByRoute = new Map();
  const stopOrderByRoute = new Map();
  forEachCsvRecord(entries['stop_times.txt'], (stopTime) => {
    const trip = tripsById.get(stopTime.trip_id);
    if (!trip) return;
    if (!stopIdsByRoute.has(trip.routeId)) stopIdsByRoute.set(trip.routeId, new Set());
    stopIdsByRoute.get(trip.routeId).add(stopTime.stop_id);
    const orderKey = `${trip.routeId}:${trip.directionId || '0'}:${trip.headsign}`;
    if (!stopOrderByRoute.has(orderKey)) stopOrderByRoute.set(orderKey, []);
    stopOrderByRoute.get(orderKey).push({
      stopId: stopTime.stop_id,
      sequence: sequenceValue(stopTime.stop_sequence)
    });
  });

  const allShapeIds = new Set();
  routeShapeIds.forEach((ids) => ids.forEach((id) => allShapeIds.add(id)));
  const pointsByShape = new Map();
  forEachCsvRecord(entries['shapes.txt'], (shape) => {
    if (!allShapeIds.has(shape.shape_id)) return;
    const lat = Number(shape.shape_pt_lat);
    const lon = Number(shape.shape_pt_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!pointsByShape.has(shape.shape_id)) pointsByShape.set(shape.shape_id, []);
    pointsByShape.get(shape.shape_id).push({
      lat,
      lon,
      sequence: sequenceValue(shape.shape_pt_sequence)
    });
  });

  const routes = {};
  routeInfoById.forEach((routeInfo, routeId) => {
    const shapes = Array.from(routeShapeIds.get(routeId) || [])
      .map((shapeId) => {
        const points = (pointsByShape.get(shapeId) || [])
          .sort((first, second) => first.sequence - second.sequence)
          .map((point) => [point.lat, point.lon]);
        return { shapeId, points: simplifyShapePoints(points) };
      })
      .filter((shape) => shape.points.length > 1)
      .sort((first, second) => second.points.length - first.points.length)
      .slice(0, 4);

    const routeStopGroups = new Map();
    Array.from(stopOrderByRoute.entries())
      .filter(([key]) => key.startsWith(routeId + ':'))
      .forEach(([key, rows]) => {
        routeStopGroups.set(key, rows);
      });

    const orderedStopIds = uniqueStopsFromTrips(routeStopGroups);
    Array.from(stopIdsByRoute.get(routeId) || []).forEach((stopId) => {
      if (!orderedStopIds.includes(stopId)) orderedStopIds.push(stopId);
    });

    const stops = orderedStopIds
      .map((stopId) => stopsById.get(stopId))
      .filter(Boolean);

    const details = {
      routeId,
      shortName: routeInfo.shortName,
      longName: routeInfo.longName,
      shapes,
      stops
    };

    routes[normalizeBusRouteKey(routeInfo.shortName)] = details;
    routes[normalizeBusRouteKey(routeInfo.routeId)] = details;
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: gtfsUrl,
    routeCount: Object.keys(routes).length,
    routes
  }));

  console.log(`Wrote ${outPath}`);
  console.log(`Routes indexed: ${Object.keys(routes).length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
