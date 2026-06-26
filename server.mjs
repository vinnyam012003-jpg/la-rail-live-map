import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const metrolinkPublicFeed = 'https://rtt.metrolinktrains.com/trainlist.json';
const metrolinkCache = { fetchedAt: 0, value: null, pending: null };
const metroFeeds = {
  vehicles: {
    url: 'https://api.goswift.ly/real-time/lametro/gtfs-rt-vehicle-positions',
    cacheMs: 15000
  },
  tripUpdates: {
    url: 'https://api.goswift.ly/real-time/lametro/gtfs-rt-trip-updates',
    cacheMs: 30000
  }
};
const metroCache = {
  vehicles: { fetchedAt: 0, value: null, pending: null },
  tripUpdates: { fetchedAt: 0, value: null, pending: null }
};

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
        latitude: vehicle.position.latitude,
        longitude: vehicle.position.longitude,
        bearing: vehicle.position.bearing ?? null,
        speed: vehicle.position.speed ?? null,
        timestamp: vehicle.timestamp ? Number(vehicle.timestamp) : null
      };
    });
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
      delayStatus: train.delay_status || '',
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
      fetchPublicMetrolinkAndAmtrakVehicles()
    ]).then((results) => {
      const officialResult = results[0];
      const publicResult = results[1];
      const errors = {};
      const officialVehicles = officialResult.status === 'fulfilled'
        ? officialResult.value.map((vehicle) => ({ ...vehicle, agency: 'metrolink' }))
        : [];
      const publicVehicles = publicResult.status === 'fulfilled' ? publicResult.value : [];

      if (officialResult.status === 'rejected') errors.metrolink = officialResult.reason.message;
      if (publicResult.status === 'rejected') errors.public = publicResult.reason.message;

      const publicMetrolinkVehicles = officialVehicles.length
        ? []
        : publicVehicles.filter((vehicle) => vehicle.agency === 'metrolink');
      const amtrakVehicles = publicVehicles.filter((vehicle) => vehicle.agency === 'amtrak');

      const value = {
        updatedAt: new Date().toISOString(),
        cacheSeconds: Math.round(metrolinkFeed.cacheMs / 1000),
        vehicles: officialVehicles.concat(publicMetrolinkVehicles, amtrakVehicles),
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

async function fetchMetroGtfsRealtime(feedType) {
  const apiKey = (process.env.LA_METRO_API_KEY || '').trim();
  const feed = metroFeeds[feedType];

  if (!feed) throw new Error('Unknown Metro feed');
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('LA Metro API key is not configured');
  }

  const response = await fetch(feed.url, {
    headers: { authorization: apiKey },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`LA Metro ${feedType} feed returned HTTP ${response.status}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
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
      .then((message) => {
        const value = {
          updatedAt: new Date().toISOString(),
          cacheSeconds: Math.round(feed.cacheMs / 1000),
          ...parser(message)
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

function parseMetroVehicles(message) {
  return {
    vehicles: message.entity
      .filter((entity) => entity.vehicle?.position)
      .map((entity) => {
        const vehicle = entity.vehicle;
        return {
          id: vehicle.vehicle?.id || entity.id,
          label: vehicle.vehicle?.label || vehicle.vehicle?.id || entity.id,
          tripId: vehicle.trip?.tripId || '',
          routeId: vehicle.trip?.routeId || '',
          direction: vehicle.trip?.directionId ?? '',
          latitude: vehicle.position.latitude,
          longitude: vehicle.position.longitude,
          bearing: vehicle.position.bearing ?? null,
          speed: vehicle.position.speed ?? null,
          timestamp: numberFromGtfs(vehicle.timestamp)
        };
      })
  };
}

function parseMetroTripUpdates(message) {
  return {
    updates: message.entity
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
            arrivalTime: numberFromGtfs(stopUpdate.arrival?.time),
            departureTime: numberFromGtfs(stopUpdate.departure?.time)
          }))
        };
      })
  };
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
