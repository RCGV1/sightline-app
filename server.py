#!/usr/bin/env python3
"""Sightline server. Dev: loopback-only. Prod: configurable via env."""
import argparse
import hashlib
import io
import json
import logging
import math
import mimetypes
import os
from pathlib import Path
import re
import tempfile
import threading
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from xml.sax.saxutils import escape

from engine import Scene, analyze, viewshed, map_image, scene_manifest, settings
from lidar import import_lidar

ROOT=Path(__file__).resolve().parent
LOCK=threading.Lock()
SCENE=None
IMAGES={}
JOBS={}
FETCH_LOCK=threading.Lock()

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger('sightline')

def _is_production():
    """True when running in published/production mode."""
    if os.getenv('PUBLISHED','').lower() in ('1','true','yes','on'):
        return True
    if os.getenv('ENV','').lower() in ('production','prod','published'):
        return True
    # Common PaaS indicators
    if os.getenv('FLY_APP_NAME') or os.getenv('RENDER') or os.getenv('RAILWAY_ENVIRONMENT'):
        return True
    # PORT set by platform without explicit HOST usually means production
    if os.getenv('PORT') and not os.getenv('HOST'):
        # Only treat as prod if not explicitly localhost dev
        return False  # keep dev default unless PUBLISHED=1
    return False

def _allowed_hosts_list():
    raw = os.getenv('ALLOWED_HOSTS','').strip()
    if not raw:
        return []
    # Support comma or space separated
    parts = re.split(r'[,\s]+', raw)
    return [p.strip().lower() for p in parts if p.strip()]

def _data_mutations_allowed():
    return not _is_production() or os.getenv('ALLOW_DATA_MUTATIONS','').lower() in ('1','true','yes','on')

PRESETS = {
    'wifi5_dish': {
        'id': 'wifi5_dish',
        'name': '5.8 GHz High-Gain Dish (PTP Backhaul)',
        'frequency_mhz': 5800,
        'tx_power_dbm': 24,
        'antenna_gain_a_dbi': 23,
        'antenna_gain_b_dbi': 23,
        'cable_loss_a_db': 1.0,
        'cable_loss_b_db': 1.0,
        'channel_width_mhz': 40,
        'rx_sensitivity_dbm': -79,
        'k_factor': 1.333,
        'foliage_db_m': 0.35,
    },
    'wifi5_panel': {
        'id': 'wifi5_panel',
        'name': '5.2 GHz Medium-Range Panel',
        'frequency_mhz': 5200,
        'tx_power_dbm': 20,
        'antenna_gain_a_dbi': 16,
        'antenna_gain_b_dbi': 16,
        'cable_loss_a_db': 1.0,
        'cable_loss_b_db': 1.0,
        'channel_width_mhz': 20,
        'rx_sensitivity_dbm': -82,
        'k_factor': 1.333,
        'foliage_db_m': 0.30,
    },
    'wifi24_ptp': {
        'id': 'wifi24_ptp',
        'name': '2.4 GHz Long-Range / Tree Foliage',
        'frequency_mhz': 2437,
        'tx_power_dbm': 20,
        'antenna_gain_a_dbi': 14,
        'antenna_gain_b_dbi': 14,
        'cable_loss_a_db': 1.5,
        'cable_loss_b_db': 1.5,
        'channel_width_mhz': 20,
        'rx_sensitivity_dbm': -85,
        'k_factor': 1.333,
        'foliage_db_m': 0.15,
    },
    'wifi6_ptp': {
        'id': 'wifi6_ptp',
        'name': '6 GHz Wi-Fi 6E/7 High-Capacity PTP',
        'frequency_mhz': 6100,
        'tx_power_dbm': 22,
        'antenna_gain_a_dbi': 25,
        'antenna_gain_b_dbi': 25,
        'cable_loss_a_db': 1.0,
        'cable_loss_b_db': 1.0,
        'channel_width_mhz': 80,
        'rx_sensitivity_dbm': -74,
        'k_factor': 1.333,
        'foliage_db_m': 0.40,
    },
    'lora_915': {
        'id': 'lora_915',
        'name': '915 MHz ISM / LoRa / Mesh',
        'frequency_mhz': 915,
        'tx_power_dbm': 27,
        'antenna_gain_a_dbi': 6,
        'antenna_gain_b_dbi': 6,
        'cable_loss_a_db': 1.0,
        'cable_loss_b_db': 1.0,
        'channel_width_mhz': 0.25,
        'rx_sensitivity_dbm': -110,
        'k_factor': 1.333,
        'foliage_db_m': 0.10,
    }
}


def parse_location_coordinates(text):
    text = (text or '').strip()
    if not text:
        return None

    # 1. Google Maps / OpenStreetMap / Geo URLs
    m = re.search(r'[@\?&](?:q=)?([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)', text)
    if m:
        try:
            lat, lon = float(m.group(1)), float(m.group(2))
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                return lat, lon
        except ValueError:
            pass

    m = re.search(r'#map=\d+/([+-]?\d+\.?\d*)/([+-]?\d+\.?\d*)', text)
    if m:
        try:
            lat, lon = float(m.group(1)), float(m.group(2))
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                return lat, lon
        except ValueError:
            pass

    # 2. DMS / DDM format: e.g. 37°46'29.6"N 122°25'09.8"W or 37 46 29.6 N, 122 25 09.8 W
    dms_re = r'(\d+)[°d\s]+(\d+(?:\.\d+)?)[\'m\s]*(?:([\d\.]+)[\"s\s]*)?([NSEWnsew])'
    dms_matches = list(re.finditer(dms_re, text))
    if len(dms_matches) == 2:
        parts = {}
        for match in dms_matches:
            deg = float(match.group(1))
            minute = float(match.group(2))
            sec = float(match.group(3) or 0)
            hemi = match.group(4).upper()
            val = deg + minute / 60.0 + sec / 3600.0
            if hemi in ('S', 'W'):
                val = -val
            if hemi in ('N', 'S'):
                parts['lat'] = val
            else:
                parts['lon'] = val
        if 'lat' in parts and 'lon' in parts:
            if -90 <= parts['lat'] <= 90 and -180 <= parts['lon'] <= 180:
                return parts['lat'], parts['lon']

    # 3. Decimal with hemisphere letter: e.g. 37.7749N, 122.4194W or 122.4194W 37.7749N
    hemi_re = r'([+-]?\d+\.?\d*)\s*°?\s*([NSEWnsew])'
    hemi_matches = list(re.finditer(hemi_re, text))
    if len(hemi_matches) == 2:
        parts = {}
        for match in hemi_matches:
            val = float(match.group(1))
            hemi = match.group(2).upper()
            if hemi in ('S', 'W'):
                val = -abs(val)
            else:
                val = abs(val)
            if hemi in ('N', 'S'):
                parts['lat'] = val
            else:
                parts['lon'] = val
        if 'lat' in parts and 'lon' in parts:
            if -90 <= parts['lat'] <= 90 and -180 <= parts['lon'] <= 180:
                return parts['lat'], parts['lon']

    # 4. JSON / Tuple / plain numbers: [37.77, -122.42], (37.77, -122.42), 37.77, -122.42
    clean = re.sub(r'[\[\]\(\)\{\}\"\'a-zA-Z_:]+', ' ', text).replace(';', ',')
    nums = re.findall(r'[+-]?\d+\.?\d*', clean)
    if len(nums) == 2:
        try:
            n1, n2 = float(nums[0]), float(nums[1])
            if -90 <= n1 <= 90 and -180 <= n2 <= 180:
                return n1, n2
            if -180 <= n1 <= 180 and -90 <= n2 <= 90:
                return n2, n1
        except ValueError:
            pass

    return None


def geocode_location(query):
    query = (query or '').strip()
    if not query:
        return []

    coords = parse_location_coordinates(query)
    if coords:
        lat, lon = coords
        return [{
            'name': f'{lat:.6f}, {lon:.6f}',
            'display_name': f'Coordinates: {lat:.6f}, {lon:.6f}',
            'lat': lat,
            'lon': lon,
            'boundingbox': [lat - 0.005, lat + 0.005, lon - 0.005, lon + 0.005],
            'type': 'coordinate'
        }]

    cache_file = ROOT / 'data' / 'cache' / f'geo-{hashlib.sha256(query.lower().encode()).hexdigest()}.json'
    if cache_file.is_file():
        try:
            return json.loads(cache_file.read_text())
        except Exception:
            pass

    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({
        'q': query,
        'format': 'json',
        'limit': 5,
        'addressdetails': 1
    })
    req = urllib.request.Request(url, headers={'User-Agent': 'Sightline-Terrain-App/1.0 (local-geocoder)'})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            results = []
            for item in data:
                try:
                    lat = float(item['lat'])
                    lon = float(item['lon'])
                    raw_bbox = item.get('boundingbox', [lat, lat, lon, lon])
                    bbox = [float(x) for x in raw_bbox]
                    results.append({
                        'name': item.get('name') or item.get('display_name', '').split(',')[0],
                        'display_name': item.get('display_name', ''),
                        'lat': lat,
                        'lon': lon,
                        'boundingbox': bbox,
                        'type': item.get('type', 'place')
                    })
                except (ValueError, KeyError):
                    continue
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(results))
            return results
    except Exception:
        return []


def fetch_job(job_id,p):
    global SCENE
    def progress(message):
        with LOCK: JOBS[job_id] = dict(status="running",message=message)
    try:
        from autofetch import discover_and_fetch
        from eptfetch import fetch_ept
        from enrich import enrich_scene

        corridor = None
        if p.get("mode") == "corridor" or p.get("corridor") or (p.get("a") and p.get("b") and not p.get("center")):
            if p.get("a") and p.get("b"):
                # Server-side Fresnel-aware fallback if client sent narrow buffer for long/low-freq link
                buf = float(p.get("corridor_buffer_m", 60.0))
                try:
                    dist = math.hypot((float(p["a"][0]) - float(p["b"][0])) * 111000,
                                      (float(p["a"][1]) - float(p["b"][1])) * 85000)
                    freq = float(p.get("frequency_mhz") or 5800)
                    wave = 299.792458 / max(1, freq)
                    fresR = math.sqrt(max(0, wave * dist / 4))
                    buf = max(buf, fresR * 1.5 + 25)
                except: pass
                corridor = (p["a"], p["b"], buf)
                progress(f"Configuring corridor crop along Sites A & B ({buf:.0f} m buffer)…")

        if corridor and not p.get("center"):
            p["center"] = [(float(corridor[0][0]) + float(corridor[1][0])) / 2.0, (float(corridor[0][1]) + float(corridor[1][1])) / 2.0]
            if not p.get("radius_m"):
                p["radius_m"] = math.hypot((float(corridor[1][0]) - float(corridor[0][0])) * 111000,
                                           (float(corridor[1][1]) - float(corridor[0][1])) * 85000) / 2.0 + float(corridor[2])

        fetch_rad = float(p.get("radius_m", 1000))
        fetch_res = float(p.get("resolution_m", 3))
        progress("Discovering public height data for this area…")
        with tempfile.TemporaryDirectory(dir=ROOT/"data") as tmp:
            output=Path(tmp)/"area.npz"
            try:
                meta=fetch_ept(p.get("center"),fetch_rad,fetch_res,output,progress=progress,corridor=corridor)
            except Exception as ept_error:
                progress('Streaming source unavailable; checking original USGS survey tiles…')
                try:
                    meta=discover_and_fetch(p.get("center"),fetch_rad,fetch_res,output,progress=progress)
                except Exception as tnm_error:
                    progress('LiDAR point cloud unavailable; building terrain from USGS 3DEP / AWS elevation DEM…')
                    try:
                        from demfetch import fetch_dem
                        meta=fetch_dem(p.get("center"),fetch_rad,fetch_res,output,progress=progress,corridor=corridor)
                    except Exception as dem_error:
                        # friendly offline handling — don't dump raw URLs/DNS traces
                        def _short(msg):
                            s=str(msg)
                            if 'NameResolutionError' in s or 'nodename nor servname' in s or 'Max retries' in s:
                                return 'offline or USGS service unreachable (no internet/DNS)'
                            if len(s)>220:
                                return s[:220]+'…'
                            return s
                        raise ValueError(f'No usable height dataset could be loaded — you appear offline or the USGS service is unreachable. Try using already-loaded terrain, or try again when online. Details: EPT:{_short(ept_error)} | tiles:{_short(tnm_error)} | DEM:{_short(dem_error)}') from dem_error
            meta=enrich_scene(output,progress=progress)
            new_scene=Scene.load(output)
            with LOCK:
                output.replace(ROOT/"data"/"fetched.npz")
                SCENE=new_scene; IMAGES.clear()
                (ROOT/'data'/'active.txt').write_text('fetched.npz')
                JOBS[job_id]=dict(status="complete",meta=meta)
    except Exception as exc:
        with LOCK: JOBS[job_id]=dict(status="error",error=str(exc))
    finally:
        FETCH_LOCK.release()


def kml(scene, p):
    result = analyze(scene, p); opts = settings(p)
    coords = []
    for key in ('a', 'b'):
        lat, lon = map(float, p[key])
        z = result['mounts'][key]['total_elevation_m']
        coords.append(f'{lon},{lat},{z}')
    color = {'clear': 'ff96d653', 'foliage': 'ff55baf5', 'fresnel': 'fff581ac', 'blocked': 'ff5f67ff', 'unknown': 'ffa4a6a3'}[result['status']]
    lb = result.get('link_budget') or {}
    align = result.get('alignment') or {}
    details = [
        f"Sightline Status: {result['status'].upper()} (Direct LOS: {result['direct_status']})",
        f"Distance: {result['distance_m']:.1f} m (3D: {result['distance_3d_m']:.1f} m)",
        f"Site A: {result['mounts']['a']['mount_type']} ({result['mounts']['a']['mast_height_m']:.1f} m mast, total {result['mounts']['a']['total_elevation_m']:.1f} m)",
        f"Site B: {result['mounts']['b']['mount_type']} ({result['mounts']['b']['mast_height_m']:.1f} m mast, total {result['mounts']['b']['total_elevation_m']:.1f} m)",
        f"Alignment: A->B {align.get('azimuth_a_to_b', 0):.1f}° (tilt {align.get('tilt_a_to_b', 0):+.1f}°); B->A {align.get('azimuth_b_to_a', 0):.1f}° (tilt {align.get('tilt_b_to_a', 0):+.1f}°)",
    ]
    if lb:
        details.extend([
            f"Viability: {lb.get('viability', 'unknown').upper()}",
            f"EIRP: {lb.get('eirp_dbm', 0):.1f} dBm, FSPL: {lb.get('free_space_loss_db', 0):.1f} dB, Foliage Loss: {lb.get('foliage_loss_db', 0):.1f} dB",
            f"Rx Power: {lb.get('rx_power_dbm', 0):.1f} dBm, Sensitivity: {lb.get('rx_sensitivity_dbm', 0):.1f} dBm",
            f"Link Margin: {lb.get('link_margin_db', 0):+.1f} dB, SNR: {lb.get('snr_db', 0):.1f} dB",
        ])
    details.append(f"Source: {scene.meta['source']}. Absolute heights use the input LiDAR vertical datum; Google Earth terrain may differ. " + ' '.join(result['notes']))
    description = escape('\n'.join(details))
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Sightline analysis</name>
<description>{description}</description><Style id="path"><LineStyle><color>{color}</color><width>4</width></LineStyle></Style>
<Placemark><name>A · Site A ({result['mounts']['a']['mount_type']})</name><description>{description}</description><Point><altitudeMode>absolute</altitudeMode><coordinates>{coords[0]}</coordinates></Point></Placemark>
<Placemark><name>B · Site B ({result['mounts']['b']['mount_type']})</name><description>{description}</description><Point><altitudeMode>absolute</altitudeMode><coordinates>{coords[1]}</coordinates></Point></Placemark>
<Placemark><name>{result['status'].upper()} · {result['distance_m']:.0f} m</name><description>{description}</description><styleUrl>#path</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>{' '.join(coords)}</coordinates></LineString></Placemark>
</Document></kml>'''.encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.info("%s - - [%s] %s" %
                    (self.client_address[0],
                     self.log_date_time_string(),
                     format%args))

    def _cors_headers(self):
        origin = self.headers.get('Origin')
        if _is_production():
            allowed = _allowed_hosts_list()
            if origin:
                oh = urlparse(origin).netloc.split(':')[0].lower()
                if not allowed or oh in allowed or '*' in allowed:
                    self.send_header('Access-Control-Allow-Origin', origin)
                    self.send_header('Vary', 'Origin')
                # else: deny — do not send ACAO
            # no Origin → no ACAO needed (same-origin)
        else:
            if origin:
                try:
                    oh = urlparse(origin).netloc
                    if oh == self.headers.get('Host'):
                        self.send_header('Access-Control-Allow-Origin', origin)
                        self.send_header('Vary', 'Origin')
                except Exception:
                    pass
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Filename')
        self.send_header('Access-Control-Max-Age', '86400')

    def send(self,status,data,kind='application/json', cache='no-store'):
        if isinstance(data,(dict,list)): data=json.dumps(data,allow_nan=False).encode()
        self.send_response(status); self.send_header('Content-Type',kind)
        self.send_header('Content-Length',str(len(data))); self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','strict-origin-when-cross-origin')
        self.send_header('Permissions-Policy','geolocation=(self)')
        if _is_production():
            self.send_header('Strict-Transport-Security','max-age=31536000; includeSubDomains')
        self._cors_headers()
        try:
            self.end_headers(); self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # Dragging endpoints aborts stale requests; the client has already
            # moved on, so there is no error response left to deliver.
            pass

    def do_OPTIONS(self):
        # CORS preflight
        if not self.allowed():
            return self.send(403,{'error':'Forbidden.'})
        self.send_response(204)
        self._cors_headers()
        self.send_header('Content-Length','0')
        self.end_headers()

    def allowed(self):
        allowed_hosts = _allowed_hosts_list()
        host = self.headers.get('Host','').split(':')[0].lower()
        origin = self.headers.get('Origin')

        if allowed_hosts:
            # Explicit allow-list mode (both dev and prod)
            if '*' in allowed_hosts:
                return True
            if host not in allowed_hosts:
                # Check origin as well - allow if origin host is in list (covers proxied hosts)
                if origin:
                    oh = urlparse(origin).netloc.split(':')[0].lower()
                    if oh in allowed_hosts:
                        return True
                return False
            if origin:
                oh = urlparse(origin).netloc.split(':')[0].lower()
                # origin must be in allowed list or match host
                if oh and oh != host and oh not in allowed_hosts:
                    return False
            return True

        # No ALLOWED_HOSTS set
        if _is_production():
            # Default allow any host when PUBLISHED=1 / production env
            return True
        # Dev mode: loopback only (backward compatible)
        raw_host = self.headers.get('Host','').split(':')[0]
        return raw_host in ('localhost','127.0.0.1') and (not origin or urlparse(origin).netloc==self.headers.get('Host'))

    def do_GET(self):
        path=urlparse(self.path).path
        # Health check outside LOCK for monitoring
        if path=='/api/health':
            return self.send(200,{'app':'sightline','version':'1.0','status':'ok'})
        if not self.allowed(): return self.send(403,{'error':'Forbidden.' if _is_production() else 'Local access only.'})
        try:
            if path=='/api/geocode':
                q = parse_qs(urlparse(self.path).query).get('q', [''])[0]
                return self.send(200, geocode_location(q))
            if path=='/api/presets':
                return self.send(200,PRESETS)
            if path.startswith('/api/jobs/'):
                with LOCK:
                    job=JOBS.get(path.rsplit('/',1)[-1])
                return self.send(200,job) if job else self.send(404,{'error':'Job not found; it may have ended when the server restarted.'})
            if path=='/api/meta':
                with LOCK:
                    meta=dict(SCENE.meta) if SCENE else {}
                meta['capabilities']={'data_mutations':_data_mutations_allowed(),'browser_scene':bool(SCENE and SCENE.h*SCENE.w<=500000)}
                return self.send(200,meta)
            if path=='/api/scene':
                with LOCK:
                    if path in IMAGES:
                        return self.send(200,IMAGES[path],'application/json',cache='public, max-age=3600')
                    scene=SCENE
                if scene is None:
                    return self.send(503,{'error':'No terrain dataset loaded. Fetch an area or wait for startup to complete.'})
                if scene.h * scene.w > 500000:
                    return self.send(413,{'error':'The active scene is too large for browser analysis. Use the server engine or fetch a smaller/coarser scene.'})
                payload=json.dumps(scene_manifest(scene),allow_nan=False,separators=(',',':')).encode()
                with LOCK:
                    IMAGES[path]=payload
                return self.send(200,payload,'application/json',cache='public, max-age=3600')
            if path in ('/api/image','/api/classes'):
                with LOCK:
                    if path in IMAGES:
                        return self.send(200,IMAGES[path],'image/png', cache='public, max-age=3600')
                    scene=SCENE
                if scene is None:
                    return self.send(503,{'error':'No terrain dataset loaded. Fetch an area or wait for startup to complete.'})
                # heavy work outside LOCK
                img = map_image(scene, path.endswith('classes'))
                with LOCK:
                    IMAGES[path]=img
                return self.send(200,img,'image/png', cache='public, max-age=3600')
            file=(ROOT/'static'/('index.html' if path=='/' else path.removeprefix('/static/').lstrip('/'))).resolve()
            if not file.is_relative_to(ROOT/'static') or not file.is_file(): return self.send(404,{'error':'Not found.'})
            ctype=mimetypes.guess_type(file)[0] or 'application/octet-stream'
            ccache='public, max-age=3600' if str(file).endswith(('.css','.js','.png','.svg','.woff2')) else 'no-store'
            return self.send(200,file.read_bytes(),ctype, cache=ccache)
        except Exception as exc:
            self.send(500,{'error':str(exc)})

    def do_POST(self):
        global SCENE
        if not self.allowed(): return self.send(403,{'error':'Forbidden.' if _is_production() else 'Local access only.'})
        path=urlparse(self.path).path
        try:
            if path in ('/api/fetch','/api/import','/api/reset') and not _data_mutations_allowed():
                return self.send(403,{'error':'Public data changes are disabled. Deploy a static scene or set ALLOW_DATA_MUTATIONS=1 for a trusted single-user server.'})
            length=int(self.headers.get('Content-Length','0'))
            limit=200*1024*1024 if path=='/api/import' else 65536
            if path != '/api/reset' and (length<=0 or length>limit): return self.send(413,{'error':f'Request must be between 1 and {limit:,} bytes.'})
            if path=='/api/import':
                query=parse_qs(urlparse(self.path).query)
                resolution=float(query.get('resolution',['3'])[0])
                with tempfile.TemporaryDirectory(dir=ROOT/'data') as tmp:
                    incoming=Path(tmp)/'import.laz'
                    with incoming.open('wb') as f:
                        remaining=length
                        while remaining:
                            block=self.rfile.read(min(1024*1024,remaining))
                            if not block: raise ValueError('Upload ended early.')
                            f.write(block); remaining-=len(block)
                    output=Path(tmp)/'scene.npz'
                    meta=import_lidar(incoming,output,resolution=resolution,name='Imported LiDAR',source='User-supplied LAS/LAZ; verify survey date and classification.',crs_override=query.get('crs',[None])[0],vertical_unit=query.get('vertical_unit',[None])[0])
                    new_scene=Scene.load(output)
                    with LOCK:
                        output.replace(ROOT/'data'/'imported.npz')
                        SCENE=new_scene; IMAGES.clear()
                        (ROOT/'data'/'active.txt').write_text('imported.npz')
                    return self.send(200,meta)
            p=json.loads(self.rfile.read(length)) if length > 0 else {}
            if not isinstance(p,dict): raise ValueError('Expected a JSON object.')
            with LOCK: scene=SCENE
            if path in ('/api/los','/api/viewshed','/api/kml') and scene is None:
                return self.send(503,{'error':'No terrain dataset loaded. Fetch an area or wait for startup to complete.'})
            if path=='/api/fetch':
                if not FETCH_LOCK.acquire(blocking=False): return self.send(409,{'error':'An area download is already running.'})
                job_id=uuid.uuid4().hex
                with LOCK: JOBS[job_id]=dict(status='running',message='Starting area download…')
                threading.Thread(target=fetch_job,args=(job_id,p),daemon=True).start()
                return self.send(202,{'job_id':job_id})
            if path=='/api/los': return self.send(200,analyze(scene,p))
            if path=='/api/viewshed': return self.send(200,viewshed(scene,p))
            if path=='/api/kml': return self.send(200,kml(scene,p),'application/vnd.google-earth.kml+xml')
            if path=='/api/reset':
                primary = 'bay-area.npz' if (ROOT/'data'/'bay-area.npz').is_file() else 'autzen.npz'
                new_scene=Scene.load(ROOT/'data'/primary)
                with LOCK:
                    SCENE=new_scene; IMAGES.clear()
                    (ROOT/'data'/'active.txt').write_text(primary)
                return self.send(200,new_scene.meta)
            self.send(404,{'error':'Unknown endpoint.'})
        except (ValueError,TypeError,KeyError,OverflowError) as exc:
            self.send(400,{'error':str(exc)})
        except Exception as exc:
            self.send(500,{'error':str(exc)})


def default_scene_path():
    active = ROOT / 'data' / 'active.txt'
    name = active.read_text().strip() if active.exists() else 'bay-area.npz'
    candidate = (ROOT / 'data' / Path(name).name).resolve()
    if candidate.is_file() and candidate.suffix == '.npz' and candidate.parent == (ROOT / 'data'):
        return candidate
    for fallback in ('bay-area.npz', 'long-range-test.npz', 'autzen.npz'):
        fb = ROOT / 'data' / fallback
        if fb.is_file():
            return fb
    raise FileNotFoundError('No usable scene dataset found in data/.')


def _resolve_host_port(args):
    # Env takes precedence over CLI defaults; CLI explicit flag overrides env
    # Detect if --port was passed explicitly
    import sys
    port_cli_overridden = any(a.startswith('--port') for a in sys.argv)
    env_port = os.getenv('PORT')
    env_host = os.getenv('HOST')
    # Host: env HOST > default by mode
    if env_host:
        host = env_host
    else:
        host = '0.0.0.0' if _is_production() else '127.0.0.1'
    # Port: env PORT > CLI default, but CLI explicit wins
    if env_port and not port_cli_overridden:
        try:
            port = int(env_port)
        except ValueError:
            port = args.port
    else:
        port = args.port
    return host, port

def main():
    global SCENE
    parser=argparse.ArgumentParser(description='Sightline local LiDAR viewshed app')
    parser.add_argument('--scene',type=Path)
    parser.add_argument('--port',type=int,default=18765)
    parser.add_argument('--host',type=str,default=None, help='Bind host (default: 127.0.0.1 dev, 0.0.0.0 prod; or HOST env)')
    args=parser.parse_args()
    if args.scene is None:
        args.scene = default_scene_path()
    SCENE=Scene.load(args.scene)
    host, port = _resolve_host_port(args)
    # CLI --host explicit overrides env/mode
    if args.host:
        host = args.host
    addr = (host, port)
    server=ThreadingHTTPServer(addr,Handler)
    mode = 'production' if _is_production() else 'development (loopback)'
    logger.info(f'Sightline starting in {mode} mode on {host}:{port}  scene={args.scene.name}')
    # Friendly URL for logs: use localhost if bound to all interfaces
    display_host = '127.0.0.1' if host == '0.0.0.0' else host
    print(f'Sightline ready ({mode}): http://{display_host}:{port}',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info('Shutting down.')
        server.shutdown()


if __name__=='__main__': main()
