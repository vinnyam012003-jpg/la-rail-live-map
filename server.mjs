import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const root = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(root, 'LA Metro & Metrolink Live Map.html');

loadLocalEnv(join(root, 'private', '.env'));
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
const serverStartedAt = Date.now();
const devStatusSessionToken = randomBytes(32).toString('hex');
const telemetry = {
  requests: [],
  endpointCounts: new Map(),
  appLogs: [],
  viewers: new Map(),
  viewerEvents: [],
  metroApiCalls: [],
  metrolinkLiveFetches: 0,
  metrolinkCacheHits: 0,
  feedStatus: new Map(),
  vehicleCounts: { metro: 0, metrolink: 0, amtrak: 0 },
  scheduleSources: new Map()
};

function appVersion() {
  try {
    const html = readFileSync(htmlPath, 'utf8');
    return html.match(/APP_VERSION = '([^']+)'/)?.[1] || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

function addAppLog(type, message, details = {}) {
  telemetry.appLogs.push({
    time: new Date().toISOString(),
    type,
    message,
    details
  });
  if (telemetry.appLogs.length > 250) telemetry.appLogs.splice(0, telemetry.appLogs.length - 250);
}

function endpointName(pathname) {
  if (pathname === '/' || pathname === '/index.html') return 'map';
  if (pathname.startsWith('/api/')) return pathname;
  if (pathname === '/dev-status') return '/dev-status';
  return pathname || 'unknown';
}

function pruneTelemetry() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  telemetry.requests = telemetry.requests.filter((entry) => entry.time >= cutoff);
  telemetry.viewerEvents = telemetry.viewerEvents.filter((entry) => entry.time >= cutoff);
  telemetry.metroApiCalls = telemetry.metroApiCalls.filter((entry) => entry.time >= Date.now() - 15 * 60 * 1000);
  for (const [viewerId, viewer] of telemetry.viewers.entries()) {
    if (viewer.lastSeen < cutoff) telemetry.viewers.delete(viewerId);
  }
}

function parseCookies(cookieHeader = '') {
  const cookies = new Map();
  cookieHeader.split(';').forEach((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  });
  return cookies;
}

function appendSetCookie(response, cookie) {
  const current = response.getHeader('Set-Cookie');
  if (!current) {
    response.setHeader('Set-Cookie', cookie);
    return;
  }
  response.setHeader('Set-Cookie', Array.isArray(current) ? [...current, cookie] : [current, cookie]);
}

function recordRequest(request, response, url) {
  pruneTelemetry();
  const endpoint = endpointName(url.pathname);
  const now = Date.now();
  telemetry.requests.push({ time: now, endpoint, method: request.method || 'GET' });
  telemetry.endpointCounts.set(endpoint, (telemetry.endpointCounts.get(endpoint) || 0) + 1);

  if (endpoint === '/dev-status' || endpoint.startsWith('/favicon') || endpoint.startsWith('/icon-')) return;

  const cookies = parseCookies(request.headers.cookie || '');
  let viewerId = cookies.get('larail_viewer');
  if (!viewerId || !/^[a-f0-9]{32}$/.test(viewerId)) {
    viewerId = randomBytes(16).toString('hex');
    appendSetCookie(response, `larail_viewer=${viewerId}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  const viewer = telemetry.viewers.get(viewerId) || { firstSeen: now, lastSeen: now };
  viewer.lastSeen = now;
  telemetry.viewers.set(viewerId, viewer);
  telemetry.viewerEvents.push({ time: now, viewerId });
}

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
    telemetry.metrolinkCacheHits += 1;
    return { ...metrolinkCache.value, cacheAgeMs: now - metrolinkCache.fetchedAt };
  }

  if (!metrolinkCache.pending) {
    telemetry.metrolinkLiveFetches += 1;
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
      Object.entries(errors).forEach(([feed, message]) => {
        telemetry.feedStatus.set(feed, { lastErrorAt: new Date().toISOString(), lastError: message });
        addAppLog('feed-error', `${feed}: ${message}`);
      });

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
      telemetry.feedStatus.set('metrolinkVehicles', {
        lastSuccessAt: value.updatedAt,
        lastErrorAt: errors.metrolink ? new Date().toISOString() : telemetry.feedStatus.get('metrolinkVehicles')?.lastErrorAt || null,
        lastError: errors.metrolink || telemetry.feedStatus.get('metrolinkVehicles')?.lastError || ''
      });
      telemetry.vehicleCounts.metrolink = vehicles.filter((vehicle) => vehicle.agency === 'metrolink').length;
      telemetry.vehicleCounts.amtrak = vehicles.filter((vehicle) => vehicle.agency === 'amtrak').length;
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
    telemetry.metroApiCalls.push({ time: Date.now(), feedType, url: feedUrl });
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
        telemetry.feedStatus.set(`metro-${feedType}`, {
          lastSuccessAt: value.updatedAt,
          lastErrorAt: result.errors.length ? new Date().toISOString() : telemetry.feedStatus.get(`metro-${feedType}`)?.lastErrorAt || null,
          lastError: result.errors.join('; ') || telemetry.feedStatus.get(`metro-${feedType}`)?.lastError || ''
        });
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
  const vehicles = messages.flatMap((message) => message.entity)
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
      });
  telemetry.vehicleCounts.metro = vehicles.length;
  return { vehicles };
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
  const allowMetroBrtRoutes = ['g', 'j', '901', '910', '950', 'orange line', 'silver line']
    .some((value) => routeWhitelist.has(value));
  return values.some((value) => {
    if (routeWhitelist.has(value)) return true;
    if (allowMetroBrtRoutes && /^(901|910|950)(?:\b|-)/.test(value)) return true;
    if (allowMetroBrtRoutes && /\b(g|j)\s*line\b/.test(value)) return true;
    if (allowMetroBrtRoutes && (value.includes('orange line') || value.includes('silver line'))) return true;
    return false;
  });
}

function metroRailRouteWhitelistFromLines(lines) {
  const map = {
    a: ['a', '801'],
    b: ['b', '802'],
    c: ['c', '803'],
    e: ['e', '804'],
    d: ['d', '805'],
    k: ['k', '807', '808']
  };
  const whitelist = new Set();
  lines.forEach((line) => {
    const key = String(line || '')
      .trim()
      .toLowerCase()
      .replace(/\bmetro\b/g, '')
      .replace(/\bline\b/g, '')
      .trim();
    (map[key] || [key]).forEach((value) => whitelist.add(value));
  });
  return Array.from(whitelist);
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
  const metroRailLines = splitQueryList(requestUrl.searchParams.get('metroRailLines'));
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
        routeWhitelist: metroRailRouteWhitelistFromLines(metroRailLines),
        fullServiceDay: true,
        serviceDayStartHour: metroRailServiceDayStartHour,
        maxRows: 500
      });
      telemetry.scheduleSources.set('metroRail', { source: 'static GTFS', lastSuccessAt: new Date().toISOString(), rows: metro.length });
    } catch (error) {
      errors.metro = error.message;
      telemetry.scheduleSources.set('metroRail', { source: 'static GTFS', lastErrorAt: new Date().toISOString(), lastError: error.message });
      addAppLog('schedule-error', `Metro rail schedule: ${error.message}`);
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
      telemetry.scheduleSources.set('metroBrt', { source: 'prebuilt static GTFS', lastSuccessAt: new Date().toISOString(), rows: metroBrt.length });
    } catch (error) {
      errors.metroBrt = error.message;
      telemetry.scheduleSources.set('metroBrt', { source: 'prebuilt static GTFS', lastErrorAt: new Date().toISOString(), lastError: error.message });
      addAppLog('schedule-error', `Metro G/J schedule: ${error.message}`);
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
      telemetry.scheduleSources.set('metrolink', { source: 'static GTFS', lastSuccessAt: new Date().toISOString(), rows: metrolink.length });
    } catch (error) {
      errors.metrolink = error.message;
      telemetry.scheduleSources.set('metrolink', { source: 'static GTFS', lastErrorAt: new Date().toISOString(), lastError: error.message });
      addAppLog('schedule-error', `Metrolink schedule: ${error.message}`);
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
    telemetry.feedStatus.set('metro-vehicles', {
      lastSuccessAt: telemetry.feedStatus.get('metro-vehicles')?.lastSuccessAt || null,
      lastErrorAt: new Date().toISOString(),
      lastError: error.message
    });
    addAppLog('feed-error', `metro vehicles: ${error.message}`);
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
    telemetry.feedStatus.set('metro-tripUpdates', {
      lastSuccessAt: telemetry.feedStatus.get('metro-tripUpdates')?.lastSuccessAt || null,
      lastErrorAt: new Date().toISOString(),
      lastError: error.message
    });
    addAppLog('feed-error', `metro trip updates: ${error.message}`);
    sendJson(response, 503, {
      updatedAt: new Date().toISOString(),
      updates: [],
      errors: { metro: error.message }
    });
  }
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20000) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function safeCompare(first, second) {
  const firstBuffer = Buffer.from(String(first || ''));
  const secondBuffer = Buffer.from(String(second || ''));
  if (firstBuffer.length !== secondBuffer.length) return false;
  return timingSafeEqual(firstBuffer, secondBuffer);
}

function isDevStatusAuthenticated(request) {
  const cookies = parseCookies(request.headers.cookie || '');
  return safeCompare(cookies.get('dev_status_session'), devStatusSessionToken);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(html);
}

function sendDevStatusLogin(response, message = '') {
  sendHtml(response, 200, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LA Rail Dev Status</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111820; color: #ecf2f7; font-family: Arial, sans-serif; }
    form { width: min(420px, calc(100vw - 32px)); background: #202933; border: 1px solid #384653; border-radius: 22px; padding: 28px; box-shadow: 0 18px 55px rgba(0,0,0,.35); }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { color: #aebbc7; line-height: 1.4; }
    input, button { box-sizing: border-box; width: 100%; border-radius: 12px; border: 1px solid #526271; padding: 13px 14px; font-size: 16px; }
    input { background: #121920; color: #fff; margin: 12px 0; }
    button { background: #0b7f8f; color: white; font-weight: 800; cursor: pointer; }
    .error { color: #ffb4b4; font-weight: 700; }
  </style>
</head>
<body>
  <form method="post" action="/dev-status">
    <h1>Private dev status</h1>
    <p>Enter the dev password to view server telemetry.</p>
    ${message ? `<p class="error">${htmlEscape(message)}</p>` : ''}
    <input name="password" type="password" autocomplete="current-password" autofocus>
    <button type="submit">Unlock</button>
  </form>
</body>
</html>`);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function relativeAge(time) {
  if (!time) return 'never';
  const timestamp = typeof time === 'number' ? time : Date.parse(time);
  if (!Number.isFinite(timestamp)) return 'unknown';
  return `${formatDuration(Date.now() - timestamp)} ago`;
}

function uniqueViewerCountSince(ms) {
  const cutoff = Date.now() - ms;
  return new Set(telemetry.viewerEvents.filter((entry) => entry.time >= cutoff).map((entry) => entry.viewerId)).size;
}

function viewerHistoryByHour() {
  const now = new Date();
  const rows = [];
  for (let index = 23; index >= 0; index -= 1) {
    const end = new Date(now.getTime() - index * 60 * 60 * 1000);
    end.setMinutes(0, 0, 0);
    const startMs = end.getTime();
    const endMs = startMs + 60 * 60 * 1000;
    const viewers = new Set(telemetry.viewerEvents
      .filter((entry) => entry.time >= startMs && entry.time < endMs)
      .map((entry) => entry.viewerId));
    rows.push({
      label: end.toLocaleTimeString('en-US', { hour: 'numeric', timeZone: scheduleTimeZone }),
      viewers: viewers.size
    });
  }
  return rows;
}

function cacheAgeFor(cache) {
  if (!cache?.fetchedAt && !cache?.loadedAt) return 'not loaded';
  return relativeAge(cache.fetchedAt || cache.loadedAt);
}

function telemetrySnapshot() {
  pruneTelemetry();
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const activeCutoff = Date.now() - 2 * 60 * 1000;
  const recentRequests = telemetry.requests.filter((entry) => entry.time >= Date.now() - 15 * 60 * 1000);
  const endpointRows = Array.from(telemetry.endpointCounts.entries())
    .sort((first, second) => second[1] - first[1])
    .slice(0, 12);
  return {
    version: appVersion(),
    uptime: formatDuration(Date.now() - serverStartedAt),
    startedAt: new Date(serverStartedAt).toLocaleString('en-US', { timeZone: scheduleTimeZone }),
    memoryMb: {
      rss: Math.round(memory.rss / 1024 / 1024),
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024)
    },
    cpuSeconds: Math.round((cpu.user + cpu.system) / 1000000),
    activeViewers: Array.from(telemetry.viewers.values()).filter((viewer) => viewer.lastSeen >= activeCutoff).length,
    uniqueViewers15m: uniqueViewerCountSince(15 * 60 * 1000),
    uniqueViewers1h: uniqueViewerCountSince(60 * 60 * 1000),
    uniqueViewers24h: uniqueViewerCountSince(24 * 60 * 60 * 1000),
    pageLoads24h: telemetry.requests.filter((entry) => entry.endpoint === 'map').length,
    viewerHistory: viewerHistoryByHour(),
    recentRequests: recentRequests.length,
    endpointRows,
    metroApiCalls15m: telemetry.metroApiCalls.length,
    metrolinkLiveFetches: telemetry.metrolinkLiveFetches,
    metrolinkCacheHits: telemetry.metrolinkCacheHits,
    vehicleCounts: telemetry.vehicleCounts,
    feedStatus: Array.from(telemetry.feedStatus.entries()),
    scheduleSources: Array.from(telemetry.scheduleSources.entries()),
    cacheAges: [
      ['Metro vehicles', cacheAgeFor(metroCache.vehicles)],
      ['Metro trip updates', cacheAgeFor(metroCache.tripUpdates)],
      ['Metrolink vehicles', cacheAgeFor(metrolinkCache)],
      ['Metro rail GTFS', cacheAgeFor(staticScheduleCache.metro)],
      ['Metrolink GTFS', cacheAgeFor(staticScheduleCache.metrolink)],
      ['Metro G/J schedule', cacheAgeFor(prebuiltScheduleCache.metroGj)]
    ],
    logs: telemetry.appLogs.slice(-40).reverse()
  };
}

function sendDevStatusPage(response) {
  const data = telemetrySnapshot();
  const maxViewerCount = Math.max(1, ...data.viewerHistory.map((row) => row.viewers));
  sendHtml(response, 200, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>LA Rail Dev Status</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #111820; color: #eef4f8; font-family: Arial, sans-serif; }
    main { width: min(1200px, calc(100vw - 28px)); margin: 22px auto 48px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 18px; }
    h1 { margin: 0; font-size: clamp(28px, 5vw, 44px); }
    h2 { margin: 0 0 12px; font-size: 22px; }
    a, button { color: #8ee9f5; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 14px; }
    .card { background: #202933; border: 1px solid #384653; border-radius: 18px; padding: 18px; box-shadow: 0 10px 28px rgba(0,0,0,.22); }
    .big { font-size: 32px; font-weight: 900; margin: 4px 0; }
    .muted { color: #aebbc7; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #384653; padding: 9px 6px; vertical-align: top; }
    th { color: #aebbc7; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; }
    .bar-row { display: grid; grid-template-columns: 64px 1fr 42px; gap: 10px; align-items: center; margin: 8px 0; }
    .bar { height: 14px; background: #121920; border-radius: 999px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: #0b7f8f; }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 9px; background: #34414d; color: #dce8ef; font-size: 13px; }
    .danger { color: #ffb4b4; }
    .logout { border: 1px solid #526271; border-radius: 999px; padding: 10px 14px; text-decoration: none; background: #202933; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>LA Rail dev status</h1>
      <div class="muted">Private telemetry · auto-refreshes every 30 seconds</div>
    </div>
    <a class="logout" href="/dev-status?logout=1">Logout</a>
  </header>

  <section class="grid">
    <div class="card"><div class="muted">Version</div><div class="big">${htmlEscape(data.version)}</div></div>
    <div class="card"><div class="muted">Uptime</div><div class="big">${htmlEscape(data.uptime)}</div><div class="muted">Started ${htmlEscape(data.startedAt)}</div></div>
    <div class="card"><div class="muted">Memory</div><div class="big">${data.memoryMb.rss} MB</div><div class="muted">Heap ${data.memoryMb.heapUsed}/${data.memoryMb.heapTotal} MB</div></div>
    <div class="card"><div class="muted">CPU used by process</div><div class="big">${data.cpuSeconds}s</div><div class="muted">Render has the better CPU graph</div></div>
    <div class="card"><div class="muted">Active viewers</div><div class="big">${data.activeViewers}</div><div class="muted">Approx. active in last 2 min</div></div>
    <div class="card"><div class="muted">Unique viewers</div><div class="big">${data.uniqueViewers24h}</div><div class="muted">15m: ${data.uniqueViewers15m} · 1h: ${data.uniqueViewers1h} · 24h: ${data.uniqueViewers24h}</div></div>
    <div class="card"><div class="muted">Metro API calls</div><div class="big">${data.metroApiCalls15m}</div><div class="muted">Last 15 minutes</div></div>
    <div class="card"><div class="muted">Metrolink feed</div><div class="big">${data.metrolinkLiveFetches}</div><div class="muted">Live fetches · ${data.metrolinkCacheHits} cache hits</div></div>
  </section>

  <section class="grid" style="margin-top:14px;">
    <div class="card">
      <h2>Vehicles parsed</h2>
      <table><tr><th>Agency</th><th>Count</th></tr>
        ${Object.entries(data.vehicleCounts).map(([agency, count]) => `<tr><td>${htmlEscape(agency)}</td><td>${count}</td></tr>`).join('')}
      </table>
    </div>
    <div class="card">
      <h2>Cache age</h2>
      <table><tr><th>Feed</th><th>Age</th></tr>
        ${data.cacheAges.map(([name, age]) => `<tr><td>${htmlEscape(name)}</td><td>${htmlEscape(age)}</td></tr>`).join('')}
      </table>
    </div>
    <div class="card">
      <h2>Request endpoints</h2>
      <table><tr><th>Endpoint</th><th>Total</th></tr>
        ${data.endpointRows.map(([endpoint, count]) => `<tr><td>${htmlEscape(endpoint)}</td><td>${count}</td></tr>`).join('')}
      </table>
      <p class="muted">${data.recentRequests} requests in the last 15 minutes</p>
    </div>
  </section>

  <section class="card" style="margin-top:14px;">
    <h2>24-hour viewer history</h2>
    ${data.viewerHistory.map((row) => `<div class="bar-row"><span class="muted">${htmlEscape(row.label)}</span><div class="bar"><span style="width:${Math.round((row.viewers / maxViewerCount) * 100)}%"></span></div><strong>${row.viewers}</strong></div>`).join('')}
  </section>

  <section class="grid" style="margin-top:14px;">
    <div class="card">
      <h2>Feed status</h2>
      <table><tr><th>Feed</th><th>Last success</th><th>Last error</th></tr>
        ${data.feedStatus.map(([feed, status]) => `<tr><td>${htmlEscape(feed)}</td><td>${htmlEscape(relativeAge(status.lastSuccessAt))}</td><td class="${status.lastError ? 'danger' : ''}">${htmlEscape(status.lastError || 'none')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No feed activity yet.</td></tr>'}
      </table>
    </div>
    <div class="card">
      <h2>Schedule sources</h2>
      <table><tr><th>Schedule</th><th>Source</th><th>Status</th></tr>
        ${data.scheduleSources.map(([schedule, status]) => `<tr><td>${htmlEscape(schedule)}</td><td>${htmlEscape(status.source)}</td><td>${htmlEscape(status.lastError || `${status.rows ?? 0} rows · ${relativeAge(status.lastSuccessAt)}`)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No station schedules requested yet.</td></tr>'}
      </table>
    </div>
  </section>

  <section class="card" style="margin-top:14px;">
    <h2>Recent app logs</h2>
    ${data.logs.length ? data.logs.map((log) => `<p><span class="pill">${htmlEscape(log.type)}</span> <span class="muted">${htmlEscape(new Date(log.time).toLocaleTimeString('en-US', { timeZone: scheduleTimeZone }))}</span> ${htmlEscape(log.message)}</p>`).join('') : '<p class="muted">No recent app log entries.</p>'}
  </section>
</main>
</body>
</html>`);
}

async function handleDevStatus(request, response, url) {
  const configuredPassword = (process.env.DEV_STATUS_PASSWORD || '').trim();
  if (!configuredPassword) {
    sendHtml(response, 503, '<!DOCTYPE html><h1>Dev status is not configured</h1><p>Set DEV_STATUS_PASSWORD in Render Environment Variables.</p>');
    return;
  }

  if (url.searchParams.get('logout') === '1') {
    appendSetCookie(response, 'dev_status_session=; Path=/dev-status; Max-Age=0; HttpOnly; SameSite=Lax');
    sendDevStatusLogin(response, 'Logged out.');
    return;
  }

  if (request.method === 'POST') {
    const body = await readRequestBody(request);
    const form = new URLSearchParams(body);
    if (safeCompare(form.get('password') || '', configuredPassword)) {
      appendSetCookie(response, `dev_status_session=${devStatusSessionToken}; Path=/dev-status; HttpOnly; SameSite=Lax`);
      response.writeHead(303, { Location: '/dev-status' });
      response.end();
      return;
    }
    sendDevStatusLogin(response, 'Incorrect password.');
    return;
  }

  if (!isDevStatusAuthenticated(request)) {
    sendDevStatusLogin(response);
    return;
  }

  sendDevStatusPage(response);
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
    recordRequest(request, response, url);

    if (url.pathname === '/dev-status') {
      await handleDevStatus(request, response, url);
      return;
    }

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
  addAppLog('server-start', `Server started on ${displayHost}:${port}`);
  console.log(`LA Rail live map: http://${displayHost}:${port}`);
});
