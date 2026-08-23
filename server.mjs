import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const root = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(root, 'LA Metro & Metrolink Live Map.html');

loadLocalEnv(join(root, '.env'));

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const metrolinkFeed = {
  url: 'https://metrolink-gtfsrt.gbsdigital.us/feed/gtfsrt-vehicles',
  headers: { 'X-Api-Key': (process.env.METROLINK_API_KEY || '').trim() },
  cacheMs: 30000
};
const metrolinkTripUpdatesFeed = 'https://metrolink-gtfsrt.gbsdigital.us/feed/gtfsrt-trips';
const metrolinkAlertsFeed = 'https://cdn.simplifytransit.com/metrolink/alerts/service-alerts.pb';
const metrolinkPublicFeed = 'https://rtt.metrolinktrains.com/trainlist.json';
const metrolinkCache = { fetchedAt: 0, value: null, pending: null };
const metroFeeds = {
  vehicles: {
    urls: [
      'https://api.goswift.ly/real-time/lametro/gtfs-rt-vehicle-positions',
      'https://api.goswift.ly/real-time/lametro-rail/gtfs-rt-vehicle-positions'
    ],
    cacheMs: 35000
  },
  tripUpdates: {
    urls: [
      'https://api.goswift.ly/real-time/lametro/gtfs-rt-trip-updates',
      'https://api.goswift.ly/real-time/lametro-rail/gtfs-rt-trip-updates'
    ],
    cacheMs: 70000
  }
};
const metroCache = {
  vehicles: { fetchedAt: 0, value: null, pending: null },
  tripUpdates: { fetchedAt: 0, value: null, pending: null }
};
const staticScheduleFeeds = {
  metro: {
    agency: 'metro',
    label: 'LA Metro',
    url: 'https://gitlab.com/LACMTA/gtfs_rail/-/raw/master/gtfs_rail.zip',
    cacheMs: 6 * 60 * 60 * 1000
  },
  metrolink: {
    agency: 'metrolink',
    label: 'Metrolink',
    url: 'https://metrolinktrains.com/globalassets/about/gtfs/gtfs.zip',
    cacheMs: 6 * 60 * 60 * 1000
  }
};
const staticScheduleCache = {
  metro: { fetchedAt: 0, value: null, pending: null },
  metrolink: { fetchedAt: 0, value: null, pending: null }
};
const metroGjSchedulePath = join(root, 'data', 'metro-gj-schedule.json');
const prebuiltScheduleCache = {
  metroGj: { loadedAt: 0, value: null, pending: null }
};
const scheduleHorizonSeconds = 6 * 60 * 60;
const metroRailServiceDayStartHour = 4;
const scheduleTimeZone = 'America/Los_Angeles';

function loadLocalEnv(path) {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function fetchMetrolinkVehicles() {
  const apiKey = (process.env.METROLINK_API_KEY || '').trim();

  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('Metrolink API key is not configured');
  }

  const response = await fetch(metrolinkFeed.url, {
    headers: metrolinkFeed.headers,
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Metrolink feed returned HTTP ${response.status}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  const message = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

  return message.entity
    .filter((entity) => entity.vehicle?.position)
    .map((entity) => {
      const vehicle = entity.vehicle;
      return {
        id: vehicle.vehicle?.id || entity.id,
        label: vehicle.vehicle?.label || vehicle.vehicle?.id || entity.id,
        tripId: vehicle.trip?.tripId || '',
        routeId: vehicle.trip?.routeId || '',
        direction: vehicle.trip?.directionId ?? '',
        currentStopSequence: numberFromGtfs(vehicle.currentStopSequence),
        currentStatus: vehicle.currentStatus ?? '',
        stopId: vehicle.stopId || '',
        latitude: vehicle.position.latitude,
        longitude: vehicle.position.longitude,
        bearing: vehicle.position.bearing ?? null,
        speed: vehicle.position.speed ?? null,
        timestamp: vehicle.timestamp ? Number(vehicle.timestamp) : null
      };
    });
}

async function fetchMetrolinkTripUpdates() {
  const apiKey = (process.env.METROLINK_API_KEY || '').trim();

  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('Metrolink API key is not configured');
  }

  const response = await fetch(metrolinkTripUpdatesFeed, {
    headers: metrolinkFeed.headers,
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Metrolink trip updates feed returned HTTP ${response.status}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  const message = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

  return message.entity
    .filter((entity) => entity.tripUpdate?.trip)
    .map((entity) => {
      const tripUpdate = entity.tripUpdate;
      return {
        id: entity.id,
        tripId: tripUpdate.trip?.tripId || entity.id,
        routeId: tripUpdate.trip?.routeId || '',
        direction: tripUpdate.trip?.directionId ?? '',
        timestamp: numberFromGtfs(tripUpdate.timestamp),
        stopTimeUpdates: (tripUpdate.stopTimeUpdate || []).map((stopUpdate) => ({
          stopId: stopUpdate.stopId || '',
          stopSequence: numberFromGtfs(stopUpdate.stopSequence),
          arrivalTime: numberFromGtfs(stopUpdate.arrival?.time),
          departureTime: numberFromGtfs(stopUpdate.departure?.time)
        }))
      };
    });
}

function textFromGtfsTranslatedString(value) {
  const translations = value?.translation || [];
  const english = translations.find((translation) => /^en\b/i.test(String(translation.language || '')));
  return String((english || translations[0])?.text || '').replace(/\s+/g, ' ').trim();
}

function normalizeTrainNumber(value) {
  const match = String(value || '').match(/\d{2,5}/);
  return match ? match[0] : '';
}

function trainNumbersFromAlertText(text) {
  const numbers = new Set();
  const pattern = /\b(?:train|trains?)\s+([A-Z]?\d{2,5}[A-Z]?)\b/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const number = normalizeTrainNumber(match[1]);
    if (number) numbers.add(number);
  }
  return numbers;
}

function normalizeMetrolinkRouteKey(value) {
  let key = String(value || '').toLowerCase();
  key = key.replace(/\bmetrolink\b/g, '');
  key = key.replace(/\bline\b/g, '');
  key = key.replace(/\bpacific\s+surfliner\b/g, 'pac surf');
  key = key.replace(/\bantelope\s+valley\b/g, 'av');
  key = key.replace(/\bsan\s+bernardino\b/g, 'sb');
  key = key.replace(/\binland\s+emp(?:ire)?\.?\s*[-/]\s*orange\s+co(?:unty)?\.?\b/g, 'ieoc');
  key = key.replace(/\bventura\s+county\b/g, 'vc');
  key = key.replace(/\borange\s+county\b/g, 'oc');
  key = key.replace(/\b91\s*\/\s*perris\s+valley\b/g, '91pv');
  return key.replace(/[^a-z0-9]/g, '');
}

function routeKeysFromVehicle(vehicle) {
  return [
    vehicle.routeId,
    vehicle.rawRouteId,
    vehicle.routeName,
    vehicle.line
  ].map(normalizeMetrolinkRouteKey).filter(Boolean);
}

function alertTextLooksDelayRelated(text) {
  return /\b(delay|delayed|late|hold|holding|cancel|canceled|cancelled|closure|closed|bus bridge|replacement bus|suspended|incident)\b/i.test(text);
}

function alertTextLooksMaintenanceRelated(text) {
  return /\b(maintenance|scheduled|planned|construction|track work|work window|repair|repairs|upgrade|upgrades)\b/i.test(text);
}

function alertCategoryForText(text) {
  if (alertTextLooksDelayRelated(text)) return 'delay';
  if (alertTextLooksMaintenanceRelated(text)) return 'maintenance';
  return 'service';
}

function activePeriodsFromAlert(alert) {
  return (alert.activePeriod || []).map((period) => ({
    start: numberFromGtfs(period.start),
    end: numberFromGtfs(period.end)
  }));
}

function alertIsActiveNow(alert, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!alert.activePeriods.length) return true;
  return alert.activePeriods.some((period) => {
    const start = period.start ?? 0;
    const end = period.end ?? Infinity;
    return start <= nowSeconds && nowSeconds <= end;
  });
}

function alertStartsWithinDays(alert, days, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!alert.activePeriods.length) return alertIsActiveNow(alert, nowSeconds);
  const horizon = nowSeconds + days * 24 * 60 * 60;
  return alert.activePeriods.some((period) => {
    const start = period.start ?? nowSeconds;
    const end = period.end ?? Infinity;
    return end >= nowSeconds && start <= horizon;
  });
}

function vehicleLooksDelayed(vehicle) {
  const status = String(vehicle.delayStatus || '').trim();
  return Boolean(status) && !/on\s*time|early|normal|good/i.test(status);
}

async function fetchMetrolinkDelayAlerts() {
  const response = await fetch(metrolinkAlertsFeed, {
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Metrolink alerts feed returned HTTP ${response.status}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  const message = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

  return message.entity
    .filter((entity) => entity.alert)
    .map((entity) => {
      const alert = entity.alert;
      const header = textFromGtfsTranslatedString(alert.headerText);
      const description = textFromGtfsTranslatedString(alert.descriptionText);
      const text = [header, description].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const tripIds = new Set();
      const routeKeys = new Set();
      const stopIds = new Set();
      const trainNumbers = trainNumbersFromAlertText(text);
      const activePeriods = activePeriodsFromAlert(alert);
      const category = alertCategoryForText(text);
      const activeNow = alertIsActiveNow({ activePeriods });

      (alert.informedEntity || []).forEach((informedEntity) => {
        if (informedEntity.trip?.tripId) tripIds.add(String(informedEntity.trip.tripId));
        if (informedEntity.trip?.routeId) routeKeys.add(normalizeMetrolinkRouteKey(informedEntity.trip.routeId));
        if (informedEntity.routeId) routeKeys.add(normalizeMetrolinkRouteKey(informedEntity.routeId));
        if (informedEntity.stopId) stopIds.add(String(informedEntity.stopId));
      });

      return {
        id: entity.id,
        text,
        tripIds,
        routeKeys,
        stopIds,
        trainNumbers,
        activePeriods,
        activeNow,
        category,
        delayRelated: category === 'delay',
        maintenanceUpcoming: category === 'maintenance' && alertStartsWithinDays({ activePeriods }, 7)
      };
    })
    .filter((alert) => alert.text);
}

function serializeAlert(alert) {
  return {
    id: alert.id,
    text: alert.text,
    category: alert.category,
    activeNow: alert.activeNow,
    maintenanceUpcoming: alert.maintenanceUpcoming,
    delayRelated: alert.delayRelated,
    tripIds: Array.from(alert.tripIds),
    routeKeys: Array.from(alert.routeKeys),
    stopIds: Array.from(alert.stopIds),
    trainNumbers: Array.from(alert.trainNumbers),
    activePeriods: alert.activePeriods
  };
}

function alertMatchesVehicle(alert, vehicle) {
  const tripId = String(vehicle.tripId || '').trim();
  if (tripId && alert.tripIds.has(tripId)) return true;

  const trainNumber = normalizeTrainNumber(vehicle.label || vehicle.id);
  if (trainNumber && alert.trainNumbers.has(trainNumber)) return true;

  if (alert.routeKeys.size) {
    const vehicleRouteKeys = routeKeysFromVehicle(vehicle);
    if (vehicleRouteKeys.some((key) => alert.routeKeys.has(key))) return true;
  }

  return false;
}

function uniqueAlertTexts(alerts) {
  const seen = new Set();
  return alerts.map((alert) => alert.text).filter((text) => {
    const key = String(text || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function delayReasonsFromAlerts(vehicle, alerts) {
  const trainNumber = normalizeTrainNumber(vehicle.label || vehicle.id);
  const tripId = String(vehicle.tripId || '').trim();
  const exactAlerts = alerts.filter((alert) =>
    (trainNumber && alert.trainNumbers.has(trainNumber)) ||
    (tripId && alert.tripIds.has(tripId))
  );

  if (exactAlerts.length) {
    return uniqueAlertTexts(exactAlerts.sort((first, second) =>
      Number(second.delayRelated) - Number(first.delayRelated)
    ));
  }

  const routeDelayAlerts = alerts.filter((alert) =>
    alert.delayRelated &&
    alertMatchesVehicle(alert, vehicle)
  );
  return uniqueAlertTexts(routeDelayAlerts);
}

async function fetchPublicMetrolinkAndAmtrakVehicles() {
  const response = await fetch(metrolinkPublicFeed, {
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Metrolink public feed returned HTTP ${response.status}`);
  }

  const data = await response.json();
  return (Array.isArray(data) ? data : []).map((train) => {
    const isAmtrak = /PAC\s*SURF|AMTRAK/i.test(String(train.line || ''));
    const delayStatus = train.delay_status || train.delayStatus || train.status || train.train_status || train.TrainStatus || '';
    const delayReason = train.delay_reason || train.DelayReason || train.status_reason || train.StatusReason ||
      train.status_message || train.StatusMessage || train.delay_message || train.DelayMessage ||
      train.reason || train.Reason || train.comment || train.Comment || '';
    return {
      agency: isAmtrak ? 'amtrak' : 'metrolink',
      id: train.symbol,
      label: train.symbol,
      tripId: '',
      routeId: train.line,
      destination: train.destination || train.dest || train.terminal || train.TrainDestination || '',
      latitude: parseMetrolinkCoordinate(train.lat),
      longitude: parseMetrolinkCoordinate(train.long),
      bearing: null,
      speed: Number(train.speed) || 0,
      direction: train.direction || train.Direction || train.dir || train.Dir || train.trainDirection || train.TrainDirection || train.heading || '',
      delayStatus,
      delayReason,
      timestamp: parseMetrolinkTimestamp(train.ptc_time)
    };
  }).filter((vehicle) => vehicle.id && Number.isFinite(vehicle.latitude) && Number.isFinite(vehicle.longitude));
}

function parseMetrolinkCoordinate(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return NaN;
  const sign = parts[0] < 0 ? -1 : 1;
  return sign * (Math.abs(parts[0]) + parts[1] / 60 + parts[2] / 3600);
}

function parseMetrolinkTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}

async function getCachedMetrolinkVehicles() {
  const now = Date.now();

  if (metrolinkCache.value && now - metrolinkCache.fetchedAt < metrolinkFeed.cacheMs) {
    return { ...metrolinkCache.value, cacheAgeMs: now - metrolinkCache.fetchedAt };
  }

  if (!metrolinkCache.pending) {
    metrolinkCache.pending = Promise.allSettled([
      fetchMetrolinkVehicles(),
      fetchPublicMetrolinkAndAmtrakVehicles(),
      fetchMetrolinkTripUpdates(),
      fetchMetrolinkDelayAlerts()
    ]).then((results) => {
      const officialResult = results[0];
      const publicResult = results[1];
      const tripUpdatesResult = results[2];
      const alertsResult = results[3];
      const errors = {};
      const officialVehicles = officialResult.status === 'fulfilled'
        ? officialResult.value.map((vehicle) => ({ ...vehicle, agency: 'metrolink' }))
        : [];
      const publicVehicles = publicResult.status === 'fulfilled' ? publicResult.value : [];
      const tripUpdates = tripUpdatesResult.status === 'fulfilled' ? tripUpdatesResult.value : [];
      const delayAlerts = alertsResult.status === 'fulfilled' ? alertsResult.value : [];

      if (officialResult.status === 'rejected') errors.metrolink = officialResult.reason.message;
      if (publicResult.status === 'rejected') errors.public = publicResult.reason.message;
      if (tripUpdatesResult.status === 'rejected') errors.metrolinkTripUpdates = tripUpdatesResult.reason.message;
      if (alertsResult.status === 'rejected') errors.metrolinkAlerts = alertsResult.reason.message;

      const publicMetrolinkVehicles = publicVehicles.filter((vehicle) => vehicle.agency === 'metrolink');
      const publicDelayByTrain = new Map();
      publicMetrolinkVehicles.forEach((vehicle) => {
        [vehicle.id, vehicle.label].map((value) => String(value || '').trim()).filter(Boolean).forEach((key) => {
          publicDelayByTrain.set(key, vehicle);
        });
      });
      const enrichedOfficialVehicles = officialVehicles.map((vehicle) => {
        const publicVehicle = publicDelayByTrain.get(String(vehicle.id || '').trim()) ||
          publicDelayByTrain.get(String(vehicle.label || '').trim());
        if (!publicVehicle) return vehicle;
        return {
          ...vehicle,
          destination: vehicle.destination || publicVehicle.destination || '',
          direction: vehicle.direction || publicVehicle.direction || '',
          delayStatus: vehicle.delayStatus || publicVehicle.delayStatus || '',
          delayReason: vehicle.delayReason || publicVehicle.delayReason || ''
        };
      });

      const fallbackMetrolinkVehicles = officialVehicles.length
        ? []
        : publicMetrolinkVehicles;
      const amtrakVehicles = publicVehicles.filter((vehicle) => vehicle.agency === 'amtrak');
      const vehicles = enrichedOfficialVehicles.concat(fallbackMetrolinkVehicles, amtrakVehicles).map((vehicle) => {
        const alertReasons = delayReasonsFromAlerts(vehicle, delayAlerts);
        return {
          ...vehicle,
          delayReason: alertReasons[0] || vehicle.delayReason || '',
          delayReasons: alertReasons.length ? alertReasons : []
        };
      });

      const value = {
        updatedAt: new Date().toISOString(),
        cacheSeconds: Math.round(metrolinkFeed.cacheMs / 1000),
        vehicles,
        alerts: delayAlerts.map(serializeAlert),
        tripUpdates,
        source: officialVehicles.length ? 'api-key' : 'public-fallback',
        errors
      };
      metrolinkCache.value = value;
      metrolinkCache.fetchedAt = Date.now();
      return value;
    }).finally(() => {
      metrolinkCache.pending = null;
    });
  }

  const value = await metrolinkCache.pending;
  return { ...value, cacheAgeMs: 0 };
}

function numberFromGtfs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value.toNumber === 'function') return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMetroRouteId(routeId) {
  return String(routeId || '').trim().replace(/-.+$/, '');
}

async function fetchMetroGtfsRealtime(feedType) {
  const apiKey = (process.env.LA_METRO_API_KEY || '').trim();
  const feed = metroFeeds[feedType];

  if (!feed) throw new Error('Unknown Metro feed');
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('LA Metro API key is not configured');
  }

  const results = await Promise.allSettled(feed.urls.map(async (feedUrl) => {
    const response = await fetch(feedUrl, {
      headers: { authorization: apiKey },
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) {
      throw new Error(`${feedUrl.replace(/^https?:\/\/[^/]+\//, '')} returned HTTP ${response.status}`);
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  }));
  const messages = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason.message);

  if (!messages.length) {
    throw new Error(`LA Metro ${feedType} feeds failed: ${errors.join('; ')}`);
  }

  return { messages, errors };
}

async function getCachedMetroFeed(feedType, parser) {
  const feed = metroFeeds[feedType];
  const cache = metroCache[feedType];
  const now = Date.now();

  if (cache.value && now - cache.fetchedAt < feed.cacheMs) {
    return { ...cache.value, cacheAgeMs: now - cache.fetchedAt };
  }

  if (!cache.pending) {
    cache.pending = fetchMetroGtfsRealtime(feedType)
      .then((result) => {
        const value = {
          updatedAt: new Date().toISOString(),
          cacheSeconds: Math.round(feed.cacheMs / 1000),
          errors: result.errors.length ? { metroPartial: result.errors.join('; ') } : {},
          ...parser(result.messages)
        };
        cache.value = value;
        cache.fetchedAt = Date.now();
        return value;
      })
      .finally(() => {
        cache.pending = null;
      });
  }

  const value = await cache.pending;
  return { ...value, cacheAgeMs: 0 };
}

function parseMetroVehicles(messages) {
  return {
    vehicles: messages.flatMap((message) => message.entity)
      .filter((entity) => entity.vehicle?.position)
      .map((entity) => {
        const vehicle = entity.vehicle;
        return {
          id: vehicle.vehicle?.id || entity.id,
          label: vehicle.vehicle?.label || vehicle.vehicle?.id || entity.id,
          tripId: vehicle.trip?.tripId || '',
          routeId: normalizeMetroRouteId(vehicle.trip?.routeId),
          rawRouteId: vehicle.trip?.routeId || '',
          direction: vehicle.trip?.directionId ?? '',
          currentStopSequence: numberFromGtfs(vehicle.currentStopSequence),
          currentStatus: vehicle.currentStatus ?? '',
          stopId: vehicle.stopId || '',
          latitude: vehicle.position.latitude,
          longitude: vehicle.position.longitude,
          bearing: vehicle.position.bearing ?? null,
          speed: vehicle.position.speed ?? null,
          timestamp: numberFromGtfs(vehicle.timestamp)
        };
      })
  };
}

function parseMetroTripUpdates(messages) {
  return {
    updates: messages.flatMap((message) => message.entity)
      .filter((entity) => entity.tripUpdate?.trip)
      .map((entity) => {
        const tripUpdate = entity.tripUpdate;
        return {
          id: entity.id,
          tripId: tripUpdate.trip?.tripId || entity.id,
          routeId: normalizeMetroRouteId(tripUpdate.trip?.routeId),
          rawRouteId: tripUpdate.trip?.routeId || '',
          direction: tripUpdate.trip?.directionId ?? '',
          timestamp: numberFromGtfs(tripUpdate.timestamp),
          stopTimeUpdates: (tripUpdate.stopTimeUpdate || []).map((stopUpdate) => ({
            stopId: stopUpdate.stopId || '',
            stopSequence: numberFromGtfs(stopUpdate.stopSequence),
            arrivalTime: numberFromGtfs(stopUpdate.arrival?.time),
            departureTime: numberFromGtfs(stopUpdate.departure?.time)
          }))
        };
      })
  };
}

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

function normalizeWords(value) {
  const ignored = new Set(['station', 'platform', 'line', 'upper', 'lower', 'level', 'the', 'metrolink']);
  return new Set(String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(/\s+/).filter((word) => word && !ignored.has(word)));
}

function namesProbablyMatch(first, second) {
  if (/union/i.test(String(first)) && /union/i.test(String(second))) return true;
  const firstWords = normalizeWords(first);
  const secondWords = normalizeWords(second);
  if (!firstWords.size || !secondWords.size) return false;
  let overlap = 0;
  firstWords.forEach((word) => {
    if (secondWords.has(word)) overlap += 1;
  });
  return overlap / Math.min(firstWords.size, secondWords.size) >= 0.6;
}

function gtfsTimeToSeconds(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

function parseGtfsDate(value) {
  const text = String(value || '');
  if (!/^\d{8}$/.test(text)) return null;
  return {
    key: text,
    year: Number(text.slice(0, 4)),
    month: Number(text.slice(4, 6)),
    day: Number(text.slice(6, 8))
  };
}

function dateKeyFromParts(parts) {
  return String(parts.year).padStart(4, '0') +
    String(parts.month).padStart(2, '0') +
    String(parts.day).padStart(2, '0');
}

function getZonedParts(date, timeZone = scheduleTimeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: String(parts.weekday || '').toLowerCase(),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function getTimeZoneOffsetMs(date, timeZone = scheduleTimeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

function zonedDateTimeEpochSeconds(parts, secondsAfterMidnight = 0, timeZone = scheduleTimeZone) {
  const baseUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const firstOffset = getTimeZoneOffsetMs(new Date(baseUtc), timeZone);
  const adjusted = baseUtc - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(adjusted), timeZone);
  return Math.floor((baseUtc - secondOffset) / 1000) + secondsAfterMidnight;
}

function shiftedDateParts(parts, dayOffset) {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, 12, 0, 0);
  const shifted = getZonedParts(new Date(utc));
  return {
    year: shifted.year,
    month: shifted.month,
    day: shifted.day,
    weekday: shifted.weekday
  };
}

function serviceIsActive(feed, serviceId, dateParts) {
  const dateKey = dateKeyFromParts(dateParts);
  const exception = feed.calendarDates.get(serviceId + ':' + dateKey);
  if (exception === '1') return true;
  if (exception === '2') return false;

  const calendar = feed.calendar.get(serviceId);
  if (!calendar) return false;
  if (dateKey < calendar.startDate || dateKey > calendar.endDate) return false;
  const days = calendar.days instanceof Set
    ? calendar.days
    : new Set(Array.isArray(calendar.days) ? calendar.days : []);
  return days.has(dateParts.weekday);
}

function addStopIndexEntry(index, stopId, entry) {
  const keys = new Set([String(stopId || '').trim(), normalizeStopKey(stopId)]);
  keys.forEach((key) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  });
}

async function fetchStaticScheduleFeed(feedKey) {
  const feedConfig = staticScheduleFeeds[feedKey];
  const cache = staticScheduleCache[feedKey];
  const now = Date.now();

  if (cache.value && now - cache.fetchedAt < feedConfig.cacheMs) return cache.value;
  if (!cache.pending) {
    cache.pending = fetch(feedConfig.url, { signal: AbortSignal.timeout(45000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${feedConfig.label} static GTFS returned HTTP ${response.status}`);
        const entries = extractZipEntries(Buffer.from(await response.arrayBuffer()), [
          'stops.txt',
          'routes.txt',
          'trips.txt',
          'stop_times.txt',
          'calendar.txt',
          'calendar_dates.txt'
        ]);
        const value = buildStaticScheduleIndex(feedConfig, entries);
        cache.value = value;
        cache.fetchedAt = Date.now();
        return value;
      })
      .finally(() => {
        cache.pending = null;
      });
  }

  return cache.pending;
}

function buildStaticScheduleIndex(feedConfig, entries) {
  const routes = new Map();
  const trips = new Map();
  const calendar = new Map();
  const calendarDates = new Map();
  const stopsById = new Map();
  const stopNameIndex = [];
  const stopTimesByStop = new Map();

  forEachCsvRecord(entries['routes.txt'], (route) => {
    routes.set(route.route_id, {
      id: route.route_id,
      shortName: route.route_short_name || route.route_id,
      longName: route.route_long_name || route.route_short_name || route.route_id
    });
  });

  forEachCsvRecord(entries['stops.txt'], (stop) => {
    const stopInfo = {
      id: stop.stop_id,
      name: stop.stop_name || stop.stop_id
    };
    stopsById.set(stop.stop_id, stopInfo);
    stopsById.set(normalizeStopKey(stop.stop_id), stopInfo);
    stopNameIndex.push(stopInfo);
  });

  forEachCsvRecord(entries['trips.txt'], (trip) => {
    const route = routes.get(trip.route_id) || { shortName: trip.route_id, longName: trip.route_id };
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

  forEachCsvRecord(entries['calendar.txt'], (row) => {
    const days = new Set();
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((day) => {
      if (row[day] === '1') days.add(day);
    });
    calendar.set(row.service_id, {
      days,
      startDate: row.start_date,
      endDate: row.end_date
    });
  });

  forEachCsvRecord(entries['calendar_dates.txt'], (row) => {
    calendarDates.set(row.service_id + ':' + row.date, row.exception_type);
  });

  forEachCsvRecord(entries['stop_times.txt'], (stopTime) => {
    const trip = trips.get(stopTime.trip_id);
    if (!trip) return;
    const seconds = gtfsTimeToSeconds(stopTime.departure_time || stopTime.arrival_time);
    if (seconds === null) return;
    const stop = stopsById.get(stopTime.stop_id) || { id: stopTime.stop_id, name: stopTime.stop_id };
    const entry = {
      agency: feedConfig.agency,
      line: trip.routeShortName || trip.routeId,
      routeId: trip.routeId,
      destination: stopTime.stop_headsign || trip.headsign || trip.routeLongName || 'Scheduled train',
      serviceId: trip.serviceId,
      directionId: trip.directionId,
      stopId: stop.id,
      stopName: stop.name,
      seconds
    };
    addStopIndexEntry(stopTimesByStop, stopTime.stop_id, entry);
  });

  return {
    agency: feedConfig.agency,
    label: feedConfig.label,
    calendar,
    calendarDates,
    stopTimesByStop,
    stopNameIndex,
    fetchedAt: new Date().toISOString()
  };
}

function scheduleObjectToMap(value) {
  return new Map(Object.entries(value || {}));
}

function scheduleCalendarObjectToMap(value) {
  return new Map(Object.entries(value || {}).map(([serviceId, calendar]) => [
    serviceId,
    {
      ...calendar,
      days: new Set(Array.isArray(calendar?.days) ? calendar.days : [])
    }
  ]));
}

function scheduleStopTimesObjectToMap(value) {
  return new Map(Object.entries(value || {}).map(([stopId, entries]) => [stopId, Array.isArray(entries) ? entries : []]));
}

async function fetchPrebuiltMetroGjScheduleFeed() {
  const cache = prebuiltScheduleCache.metroGj;
  if (cache.value) return cache.value;
  if (!cache.pending) {
    cache.pending = readFile(metroGjSchedulePath, 'utf8')
      .then((text) => {
        const data = JSON.parse(text);
        const feed = {
          agency: data.agency || 'metro',
          label: data.label || 'LA Metro G/J',
          calendar: scheduleCalendarObjectToMap(data.calendar),
          calendarDates: scheduleObjectToMap(data.calendarDates),
          stopTimesByStop: scheduleStopTimesObjectToMap(data.stopTimesByStop),
          stopNameIndex: Array.isArray(data.stopNameIndex) ? data.stopNameIndex : [],
          fetchedAt: data.generatedAt || new Date().toISOString()
        };
        cache.value = feed;
        cache.loadedAt = Date.now();
        return feed;
      })
      .catch((error) => {
        if (error?.code === 'ENOENT') {
          throw new Error('G/J schedule file is missing. Run npm run build:gj-schedule locally, then upload data/metro-gj-schedule.json.');
        }
        throw error;
      })
      .finally(() => {
        cache.pending = null;
      });
  }
  return cache.pending;
}

function getStopIdsForSchedule(feed, requestedStopIds, requestedNames) {
  const stopIds = new Set();
  requestedStopIds.forEach((stopId) => {
    const exact = String(stopId || '').trim();
    const normalized = normalizeStopKey(stopId);
    if (feed.stopTimesByStop.has(exact)) stopIds.add(exact);
    if (feed.stopTimesByStop.has(normalized)) stopIds.add(normalized);
  });

  requestedNames.forEach((name) => {
    feed.stopNameIndex.forEach((stop) => {
      if (namesProbablyMatch(name, stop.name)) stopIds.add(normalizeStopKey(stop.id));
    });
  });

  return Array.from(stopIds);
}

function routeMatchesWhitelist(entry, routeWhitelist) {
  if (!routeWhitelist?.size) return true;
  const values = [
    entry.line,
    entry.routeId
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  return values.some((value) => {
    if (routeWhitelist.has(value)) return true;
    if (/^(901|910|950)(?:\b|-)/.test(value)) return true;
    if (/\b(g|j)\s*line\b/.test(value)) return true;
    if (value.includes('orange line') || value.includes('silver line')) return true;
    return false;
  });
}

function serviceDayPartsForNow(nowParts, startHour = 0) {
  return shiftedDateParts(nowParts, nowParts.hour < startHour ? -1 : 0);
}

function destinationKeyForSchedule(entry) {
  return [
    String(entry.destination || 'Scheduled train').trim().toLowerCase(),
    String(entry.line || entry.routeId || '').trim().toLowerCase()
  ].join(':');
}

function upcomingSchedulesForFeed(feed, stopIds, names, options = {}) {
  if (typeof options === 'number') options = { limit: options };
  const limit = options.limit ?? 10;
  const maxRows = options.maxRows ?? limit;
  const horizonSeconds = options.horizonSeconds ?? scheduleHorizonSeconds;
  const fullServiceDay = Boolean(options.fullServiceDay);
  const serviceDayStartHour = options.serviceDayStartHour ?? 0;
  const routeWhitelist = options.routeWhitelist
    ? new Set(options.routeWhitelist.map((route) => String(route).trim().toLowerCase()))
    : null;
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const baseParts = getZonedParts(now);
  const currentServiceParts = serviceDayPartsForNow(baseParts, serviceDayStartHour);
  const serviceDates = fullServiceDay
    ? [
      { parts: currentServiceParts, period: 'current' },
      { parts: shiftedDateParts(currentServiceParts, 1), period: 'next' }
    ]
    : [-1, 0, 1].map((offset) => ({ parts: shiftedDateParts(baseParts, offset), period: 'current' }));
  const candidates = [];
  const matchedStopIds = getStopIdsForSchedule(feed, stopIds, names);

  matchedStopIds.forEach((stopId) => {
    (feed.stopTimesByStop.get(stopId) || []).forEach((entry) => {
      if (!routeMatchesWhitelist(entry, routeWhitelist)) return;
      serviceDates.forEach(({ parts: dateParts, period }) => {
        if (!serviceIsActive(feed, entry.serviceId, dateParts)) return;
        const timestamp = zonedDateTimeEpochSeconds(dateParts, entry.seconds);
        if (timestamp < nowSeconds - 60) return;
        if (!fullServiceDay && timestamp > nowSeconds + horizonSeconds) return;
        candidates.push({
          agency: entry.agency,
          line: entry.line,
          routeId: entry.routeId,
          destination: entry.destination,
          directionId: entry.directionId,
          stopId: entry.stopId,
          stopName: entry.stopName,
          time: timestamp,
          servicePeriod: period
        });
      });
    });
  });

  const unique = new Map();
  candidates.sort((first, second) => first.time - second.time).forEach((candidate) => {
    const key = [
      candidate.agency,
      candidate.line,
      candidate.destination,
      Math.floor(candidate.time / 60)
    ].join(':');
    if (!unique.has(key)) unique.set(key, candidate);
  });

  if (!fullServiceDay) return Array.from(unique.values()).slice(0, maxRows);

  const currentRows = [];
  const firstNextByDestination = new Map();
  Array.from(unique.values()).forEach((candidate) => {
    if (candidate.servicePeriod === 'current') {
      currentRows.push(candidate);
      return;
    }
    const destinationKey = destinationKeyForSchedule(candidate);
    if (!firstNextByDestination.has(destinationKey) ||
      candidate.time < firstNextByDestination.get(destinationKey).time) {
      firstNextByDestination.set(destinationKey, { ...candidate, firstNextServiceDay: true });
    }
  });

  return currentRows
    .concat(Array.from(firstNextByDestination.values()))
    .sort((first, second) => first.time - second.time)
    .slice(0, maxRows);
}

function splitQueryList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function sendStationSchedule(requestUrl, response) {
  const metroStopIds = splitQueryList(requestUrl.searchParams.get('metroStopIds'));
  const metroRailStopIds = [
    ...metroStopIds,
    ...splitQueryList(requestUrl.searchParams.get('metroRailStopIds'))
  ];
  const metroBrtStopIds = splitQueryList(requestUrl.searchParams.get('metroBrtStopIds'));
  const metrolinkStopIds = splitQueryList(requestUrl.searchParams.get('metrolinkStopIds'));
  const names = splitQueryList(requestUrl.searchParams.get('names'));
  const errors = {};
  let metro = [];
  let metroBrt = [];
  let metrolink = [];

  if (metroRailStopIds.length) {
    try {
      const feed = await fetchStaticScheduleFeed('metro');
      metro = upcomingSchedulesForFeed(feed, metroRailStopIds, names, {
        fullServiceDay: true,
        serviceDayStartHour: metroRailServiceDayStartHour,
        maxRows: 500
      });
    } catch (error) {
      errors.metro = error.message;
    }
  }

  if (metroBrtStopIds.length) {
    try {
      const feed = await fetchPrebuiltMetroGjScheduleFeed();
      metroBrt = upcomingSchedulesForFeed(feed, metroBrtStopIds, names, {
        routeWhitelist: ['g', 'j', '901', '910', '950'],
        fullServiceDay: true,
        serviceDayStartHour: 0,
        maxRows: 500
      });
    } catch (error) {
      errors.metroBrt = error.message;
    }
  }

  if (metrolinkStopIds.length) {
    try {
      const feed = await fetchStaticScheduleFeed('metrolink');
      metrolink = upcomingSchedulesForFeed(feed, metrolinkStopIds, names, {
        fullServiceDay: true,
        serviceDayStartHour: 0,
        maxRows: 500
      });
    } catch (error) {
      errors.metrolink = error.message;
    }
  }

  sendJson(response, 200, {
    updatedAt: new Date().toISOString(),
    horizonSeconds: scheduleHorizonSeconds,
    schedules: { metro: [...metro, ...metroBrt].sort((first, second) => first.time - second.time), metrolink },
    errors
  });
}

async function sendVehicles(response) {
  try {
    const payload = await getCachedMetrolinkVehicles();
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 503, {
      updatedAt: new Date().toISOString(),
      vehicles: [],
      errors: { metrolink: error.message }
    });
  }
}

async function sendMetroVehicles(response) {
  try {
    const payload = await getCachedMetroFeed('vehicles', parseMetroVehicles);
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 503, {
      updatedAt: new Date().toISOString(),
      vehicles: [],
      errors: { metro: error.message }
    });
  }
}

async function sendMetroTripUpdates(response) {
  try {
    const payload = await getCachedMetroFeed('tripUpdates', parseMetroTripUpdates);
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 503, {
      updatedAt: new Date().toISOString(),
      updates: [],
      errors: { metro: error.message }
    });
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === '/api/vehicles') {
      await sendVehicles(response);
      return;
    }

    if (url.pathname === '/api/metro/vehicles') {
      await sendMetroVehicles(response);
      return;
    }

    if (url.pathname === '/api/metro/trip-updates') {
      await sendMetroTripUpdates(response);
      return;
    }

    if (url.pathname === '/api/station-schedule') {
      await sendStationSchedule(url, response);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(htmlPath);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(html);
      return;
    }

    if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
      const favicon = await readFile(join(root, 'favicon.png'));
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400'
      });
      response.end(favicon);
      return;
    }

    if (url.pathname === '/icon-192.png' || url.pathname === '/icon-180.png' || url.pathname === '/icon-32.png') {
      const icon = await readFile(join(root, url.pathname.slice(1)));
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400'
      });
      response.end(icon);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`LA Rail live map: http://${displayHost}:${port}`);
});
