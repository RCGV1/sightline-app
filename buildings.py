"""Automatically fetch OSM building footprints; never invent missing heights."""
import hashlib
import json
import math
from pathlib import Path
import time

import numpy as np
import requests
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import from_origin
from shapely.geometry import Polygon, LineString, mapping
from shapely.ops import polygonize, unary_union, transform

CACHE=Path(__file__).resolve().parent/'data/cache/buildings'
ENDPOINTS=('https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter')


def parse_height_tag(tags):
    h = tags.get('height')
    if h:
        try:
            h_str = str(h).lower().replace('m', '').strip()
            if 'ft' in h_str or '\'' in h_str:
                return float(h_str.replace('ft', '').replace('\'', '').strip()) * 0.3048
            return float(h_str)
        except (ValueError, TypeError):
            pass
    levels = tags.get('building:levels')
    if levels:
        try:
            return float(levels) * 3.5
        except (ValueError, TypeError):
            pass
    return None


def polygons_with_tags(elements):
    """Handle closed ways and multipolygon relations, returning (geom, height)."""
    result = []
    for e in elements:
        tags = e.get('tags', {})
        if not (tags.get('building') not in (None, 'no') or tags.get('building:part') not in (None, 'no')):
            continue
        h = parse_height_tag(tags)
        if e.get('type') == 'way':
            coords = [(v['lon'], v['lat']) for v in e.get('geometry', [])]
            if len(coords) < 4 or coords[0] != coords[-1]:
                continue
            geom = Polygon(coords)
        elif e.get('type') == 'relation':
            outer = []
            inner = []
            for m in e.get('members', []):
                coords = [(v['lon'], v['lat']) for v in m.get('geometry', [])]
                if len(coords) < 2:
                    continue
                (inner if m.get('role') == 'inner' else outer).append(LineString(coords))
            if not outer:
                continue
            geom = unary_union(list(polygonize(unary_union(outer))))
            if inner:
                geom = geom.difference(unary_union(list(polygonize(unary_union(inner)))))
        else:
            continue
        if geom.is_valid and not geom.is_empty:
            result.append((geom, h))
    return result


def polygons(elements):
    """Handle closed ways and multipolygon relations, preserving courtyards."""
    return [geom for geom, _ in polygons_with_tags(elements)]


def fetch_footprints(meta,shape,progress=None):
    (south,west),(north,east)=meta['bounds']
    dlat_km = abs(north - south) * 111.0
    dlon_km = abs(east - west) * 85.0
    area_km2 = dlat_km * dlon_km
    dist_km = math.hypot(dlat_km, dlon_km)
    # Overpass API times out on large geographic bounding boxes (>30 km² or long corridors >8 km)
    if area_km2 > 30.0 or (meta.get('is_corridor') and dist_km > 8.0):
        if progress:
            progress('Regional scale (>30 km²): skipping dense OSM footprint query (terrain DEM & canopy active)…')
        return np.zeros(shape, dtype=np.int32), np.zeros(shape, dtype=np.float32), dict(
            source='OpenStreetMap footprint query skipped (regional scale > 30 km²)',
            endpoint='none',
            footprints=0,
            date=None
        )
    box=','.join(f'{v:.7f}' for v in (south,west,north,east))
    query=f'[out:json][timeout:60];(way["building"]({box});relation["building"]({box});way["building:part"]({box});relation["building:part"]({box}););out geom;'
    CACHE.mkdir(parents=True,exist_ok=True)
    cache=CACHE/(hashlib.sha256(query.encode()).hexdigest()+'.json')
    if progress: progress('Fetching building footprints from OpenStreetMap…')
    if cache.exists() and time.time()-cache.stat().st_mtime < 7*86400:
        data=json.loads(cache.read_text()); source='OpenStreetMap cached response'
    else:
        errors=[]
        for endpoint in ENDPOINTS:
            try:
                response=requests.get(endpoint,params={'data':query},headers={'User-Agent':'Sightline/1.0 (local geospatial analysis)'},timeout=(15,90),stream=True)
                response.raise_for_status()
                chunks=[];size=0
                for block in response.iter_content(65536):
                    size+=len(block)
                    if size>30*1024*1024: raise ValueError('Building footprint response exceeds 30 MB; use a smaller area.')
                    chunks.append(block)
                data=json.loads(b''.join(chunks))
                if data.get('remark'): raise ValueError('OSM query was incomplete: '+data['remark'])
                if not isinstance(data.get('elements'),list): raise ValueError('Invalid building footprint response.')
                cache.write_text(json.dumps(data));source=endpoint;break
            except (requests.RequestException,ValueError) as exc: errors.append(str(exc))
        else: raise ValueError('Building footprints unavailable: '+'; '.join(errors))
    project=Transformer.from_crs('EPSG:4326',meta['crs'],always_xy=True)
    tagged=polygons_with_tags(data['elements'])
    geoms=[transform(project.transform,g) for g,_ in tagged]
    heights_list=[h for _,h in tagged]
    aff=from_origin(meta['xmin'],meta['ymax'],meta['resolution_m'],meta['resolution_m'])
    labels=rasterize([(mapping(g),i+1) for i,g in enumerate(geoms)],out_shape=shape,transform=aff,all_touched=True,dtype='int32') if geoms else np.zeros(shape,dtype=np.int32)
    tag_heights=rasterize([(mapping(g),float(h)) for g,h in zip(geoms,heights_list) if h is not None and h>0],out_shape=shape,transform=aff,all_touched=True,dtype='float32',fill=0.0) if geoms else np.zeros(shape,dtype=np.float32)
    return labels,tag_heights,dict(source='© OpenStreetMap contributors, ODbL',url='https://www.openstreetmap.org/copyright',endpoint=source,footprints=len(geoms),date=data.get('osm3s',{}).get('timestamp_osm_base'))
