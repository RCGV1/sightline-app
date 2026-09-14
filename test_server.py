import json
import os
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
import xml.etree.ElementTree as ET
from http.server import ThreadingHTTPServer
import server
from engine import Scene


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.SCENE=Scene.load(Path(__file__).parent/'data/autzen.npz')
        cls.httpd=ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.httpd.serve_forever,daemon=True); cls.thread.start()
        cls.port=cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close(); cls.thread.join()

    def request(self,method,path,body=None,headers=None):
        c=HTTPConnection('127.0.0.1',self.port,timeout=10)
        c.request(method,path,body=body,headers=headers or {})
        r=c.getresponse(); data=r.read(); status=r.status; c.close(); return status,data

    def test_page_assets_and_map(self):
        for p in ('/','/static/app.js','/static/style.css','/static/vendor/leaflet/leaflet.css','/api/meta','/api/image','/api/classes'):
            code,data=self.request('GET',p);self.assertEqual(code,200,p);self.assertGreater(len(data),0)
        self.assertEqual(self.request('GET','/static/../../server.py')[0],404)

    def test_browser_scene_manifest(self):
        code, data = self.request('GET', '/api/scene')
        self.assertEqual(code, 200)
        manifest = json.loads(data)
        self.assertEqual(len(manifest['ground']), server.SCENE.h)
        self.assertEqual(len(manifest['ground'][0]), server.SCENE.w)
        self.assertIn(None, (v for row in manifest['buildings'] for v in row))
        self.assertEqual(manifest['meta']['resolution_m'], server.SCENE.meta['resolution_m'])

    def test_browser_scene_rejects_oversized_current_scene(self):
        old_scene = server.SCENE
        old_images = server.IMAGES
        try:
            oversized = type('OversizedScene', (), {'h': 1, 'w': 500001})()
            with server.LOCK:
                server.SCENE = oversized
                server.IMAGES = {}
            code, data = self.request('GET', '/api/scene')
            self.assertEqual(code, 413)
            self.assertIn('too large', json.loads(data)['error'])
        finally:
            with server.LOCK:
                server.SCENE = old_scene
                server.IMAGES = old_images

    def test_scene_renders_retry_when_the_scene_changes_during_rendering(self):
        """A slow render must not publish or return data from a replaced scene."""
        old_scene = server.SCENE
        replacement = Scene.load(Path(__file__).parent / 'data' / 'bay-area.npz')
        old_images = server.IMAGES
        try:
            for path, renderer, args in (
                ('/api/scene', 'scene_manifest', ()),
                ('/api/image', 'map_image', (False,)),
                ('/api/classes', 'map_image', (True,)),
            ):
                with self.subTest(path=path):
                    started = threading.Event()
                    release = threading.Event()
                    original = getattr(server, renderer)

                    def block_old_render(scene, *render_args, **render_kwargs):
                        if scene is old_scene and not started.is_set():
                            started.set()
                            if not release.wait(timeout=5):
                                raise RuntimeError('test did not release blocked render')
                        return original(scene, *render_args, **render_kwargs)

                    with server.LOCK:
                        server.SCENE = old_scene
                        server.IMAGES = {}
                    setattr(server, renderer, block_old_render)
                    request_thread = None
                    try:
                        response = {}
                        request_thread = threading.Thread(
                            target=lambda: response.setdefault('value', self.request('GET', path)),
                        )
                        request_thread.start()
                        self.assertTrue(started.wait(timeout=5), f'{path} did not begin rendering')
                        with server.LOCK:
                            server.SCENE = replacement
                            server.IMAGES.clear()
                        release.set()
                        request_thread.join(timeout=5)
                        self.assertFalse(request_thread.is_alive(), f'{path} request did not complete')
                        self.assertIn('value', response)
                        code, data = response['value']
                        self.assertEqual(code, 200)

                        if path == '/api/scene':
                            self.assertEqual(json.loads(data)['meta']['name'], replacement.meta['name'])
                        else:
                            self.assertEqual(data, original(replacement, *args))

                        code, cached = self.request('GET', path)
                        self.assertEqual(code, 200)
                        self.assertEqual(cached, data)
                    finally:
                        release.set()
                        if request_thread is not None:
                            request_thread.join(timeout=5)
                        setattr(server, renderer, original)
        finally:
            with server.LOCK:
                server.SCENE = old_scene
                server.IMAGES = old_images

    def test_health_and_presets(self):
        code, data = self.request('GET', '/api/health')
        self.assertEqual(code, 200)
        health = json.loads(data)
        self.assertEqual(health['app'], 'sightline')
        code, data = self.request('GET', '/api/presets')
        self.assertEqual(code, 200)
        presets = json.loads(data)
        self.assertIn('wifi5_dish', presets)
        self.assertIn('wifi24_ptp', presets)
        self.assertIn('wifi6_ptp', presets)

    def test_production_health_and_mutation_safety(self):
        old = {key: os.environ.get(key) for key in ('PUBLISHED','ALLOWED_HOSTS','ALLOW_DATA_MUTATIONS')}
        try:
            os.environ['PUBLISHED'] = '1'
            os.environ['ALLOWED_HOSTS'] = 'sightline.example'
            os.environ.pop('ALLOW_DATA_MUTATIONS', None)
            code, _ = self.request('GET', '/api/health', headers={'Host':'127.0.0.1'})
            self.assertEqual(code, 200)
            code, data = self.request('POST', '/api/reset', '{}', {'Host':'sightline.example'})
            self.assertEqual(code, 403)
            self.assertIn('disabled', json.loads(data)['error'])
        finally:
            for key, value in old.items():
                if value is None: os.environ.pop(key, None)
                else: os.environ[key] = value

    def test_los_kml_and_invalid_inputs(self):
        s=server.SCENE
        p=json.dumps(dict(a=s.meta['default_a'],b=s.meta['default_b']))
        code,data=self.request('POST','/api/los',p)
        self.assertEqual(code,200)
        result=json.loads(data)
        self.assertGreater(len(result['profile']),2)
        self.assertEqual(result['parameters']['mode'],'radio')
        code,data=self.request('POST','/api/kml',p)
        self.assertEqual(code,200)
        root=ET.fromstring(data)
        self.assertEqual(len(root.findall('.//{http://www.opengis.net/kml/2.2}Placemark')),3)
        self.assertEqual(self.request('POST','/api/los','{}')[0],400)

    def test_origin_isolation(self):
        self.assertEqual(self.request('POST','/api/los','{}',{'Origin':'https://other.example'})[0],403)
        self.assertEqual(self.request('GET','/api/meta',headers={'Host':'other.example'})[0],403)

    def test_geocode(self):
        code, data = self.request('GET', '/api/geocode?q=37.7749%2C-122.4194')
        self.assertEqual(code, 200)
        res = json.loads(data)
        self.assertEqual(len(res), 1)
        self.assertAlmostEqual(res[0]['lat'], 37.7749, places=4)
        self.assertAlmostEqual(res[0]['lon'], -122.4194, places=4)

        # DMS coordinates
        code, data = self.request('GET', '/api/geocode?q=37%C2%B046%2729.6%22N+122%C2%B025%2709.8%22W')
        self.assertEqual(code, 200)
        res = json.loads(data)
        self.assertEqual(len(res), 1)
        self.assertAlmostEqual(res[0]['lat'], 37.774888, places=3)
        self.assertAlmostEqual(res[0]['lon'], -122.419388, places=3)

        # Google Maps URL
        code, data = self.request('GET', '/api/geocode?q=https%3A%2F%2Fwww.google.com%2Fmaps%2F%4037.7524%2C-122.4475%2C15z')
        self.assertEqual(code, 200)
        res = json.loads(data)
        self.assertEqual(len(res), 1)
        self.assertAlmostEqual(res[0]['lat'], 37.7524, places=4)
        self.assertAlmostEqual(res[0]['lon'], -122.4475, places=4)

        # Empty query
        code, data = self.request('GET', '/api/geocode?q=')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(data), [])

    def test_viewshed_api_success_and_edge_cases(self):
        s = server.SCENE
        a = s.meta['default_a']

        # 1. Valid request
        payload = json.dumps({'a': a, 'radius_m': 100, 'step_m': 10})
        code, data = self.request('POST', '/api/viewshed', payload)
        self.assertEqual(code, 200)
        res = json.loads(data)
        self.assertIn('bounds', res)
        self.assertIn('image', res)
        self.assertIn('counts', res)
        self.assertIn('notes', res)
        self.assertTrue(res['image'].startswith('data:image/png;base64,'))

        # 2. Target AGL configuration
        payload_agl = json.dumps({'a': a, 'radius_m': 100, 'step_m': 10, 'target_agl': 2.0})
        code, data = self.request('POST', '/api/viewshed', payload_agl)
        self.assertEqual(code, 200)
        res_agl = json.loads(data)
        self.assertIn('Receiver height is 2.0 m above local ground', res_agl['notes'][0])

        # 3. Full mode (simple: False)
        payload_full = json.dumps({'a': a, 'radius_m': 100, 'step_m': 10, 'simple': False})
        code, data = self.request('POST', '/api/viewshed', payload_full)
        self.assertEqual(code, 200)

        # 4. Error: missing Site A
        code, data = self.request('POST', '/api/viewshed', '{}')
        self.assertEqual(code, 400)
        err = json.loads(data)
        self.assertIn('Site A coordinates', err['error'])

        # 5. Error: invalid JSON
        code, data = self.request('POST', '/api/viewshed', 'not valid json')
        self.assertEqual(code, 400)

        # 6. Error: Site A outside coverage
        payload_outside = json.dumps({'a': [0.0, 0.0], 'radius_m': 100, 'step_m': 10})
        code, data = self.request('POST', '/api/viewshed', payload_outside)
        self.assertEqual(code, 400)
        err = json.loads(data)
        self.assertIn('outside measured terrain coverage', err['error'])

        # 7. Error: excessive grid evaluation limit (>160k points)
        payload_limit = json.dumps({'a': a, 'radius_m': 50000, 'step_m': 10})
        code, data = self.request('POST', '/api/viewshed', payload_limit)
        self.assertEqual(code, 400)
        err = json.loads(data)
        self.assertIn('would evaluate', err['error'])

        # 8. Error: empty body (Content-Length 0)
        code, data = self.request('POST', '/api/viewshed', '')
        self.assertEqual(code, 413)

        # 9. Status 503 when scene is None
        with server.LOCK:
            orig_scene = server.SCENE
            server.SCENE = None
        try:
            code, data = self.request('POST', '/api/viewshed', payload)
            self.assertEqual(code, 503)
            err = json.loads(data)
            self.assertIn('No terrain dataset loaded', err['error'])
        finally:
            with server.LOCK:
                server.SCENE = orig_scene


if __name__=='__main__':unittest.main()
