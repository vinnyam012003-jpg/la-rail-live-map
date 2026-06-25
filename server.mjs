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
  headers: { 'X-Api-Key': process.env.METROLINK_API_KEY || '' }
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
  const apiKey = process.env.METROLINK_API_KEY || '';

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

async function sendVehicles(response) {
  const payload = { updatedAt: new Date().toISOString(), vehicles: [], errors: {} };
  try {
    const vehicles = await fetchMetrolinkVehicles();
    payload.vehicles = vehicles.map((vehicle) => ({ ...vehicle, agency: 'metrolink' }));
    sendJson(response, 200, payload);
  } catch (error) {
    payload.errors.metrolink = error.message;
    sendJson(response, 503, payload);
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

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(htmlPath);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(html);
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
