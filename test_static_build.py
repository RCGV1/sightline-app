import json
from pathlib import Path
import re
import tempfile
import unittest

from build_static import build


ROOT = Path(__file__).resolve().parent


class StaticBuildTests(unittest.TestCase):
    def test_build_contains_browser_scene_and_assets(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            output = Path(tmp) / 'release'
            build(ROOT / 'data' / 'bay-area.npz', output, 'https://sightline.example')
            self.assertTrue((output / 'index.html').is_file())
            self.assertTrue((output / 'static' / 'engine.js').is_file())
            self.assertTrue((output / 'static' / 'global-data.js').is_file())
            self.assertTrue((output / 'static' / 'scene-terrain.png').is_file())
            manifest = json.loads((output / 'static' / 'scene.json').read_text())
            self.assertIn('ground', manifest)
            self.assertIn('buildings', manifest)
            self.assertIn('trees', manifest)
            index = (output / 'index.html').read_text()
            app = (output / 'static' / 'app.js').read_text()
            self.assertIn('https://sightline.example/', index)
            self.assertIn(
                'content="https://sightline.example/static/favicon.svg"',
                index,
            )
            self.assertIn(
                "include_foliage:$('toggleFoliage')?.checked !== false",
                app,
            )
            self.assertIn(
                "id === 'toggleFoliage' && state.points.a && state.points.b",
                app,
            )
            headers = (output / '_headers').read_text()
            self.assertNotIn('immutable', headers)
            self.assertTrue((output / 'LICENSE').is_file())
            self.assertTrue((output / 'THIRD_PARTY_NOTICES.md').is_file())

    def test_build_marks_release_as_static_for_runtime_routing(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            output = Path(tmp) / 'release'
            build(ROOT / 'data' / 'bay-area.npz', output)
            index = (output / 'index.html').read_text()
            self.assertRegex(
                index,
                r'<script>\s*window\.SIGHTLINE_STATIC\s*=\s*true;\s*</script>',
            )

    def test_app_loads_global_data_only_when_needed(self):
        app = (ROOT / 'static' / 'app.js').read_text()
        self.assertNotIn("const GlobalDataPromise = import('./global-data.js')", app)
        self.assertRegex(
            app,
            r'(?:async\s+)?function\s+\w*GlobalData\w*\s*\([^)]*\)\s*\{'
            r'[\s\S]*?import\(\s*[\'\"]\.\/global-data\.js[\'\"]\s*\)',
        )
        self.assertRegex(
            app,
            r'globalData\.acquireScene\(request,\s*\{[\s\S]{0,700}includeFoliage\s*:',
        )
        foliage_reload = app.index("state.meta?.canopy_loaded === false")
        viewshed_branch = app.index("if (state.analysisMode === 'viewshed')", foliage_reload - 500)
        self.assertLess(foliage_reload, viewshed_branch)

    def test_primary_button_is_quietly_disabled_during_viewshed(self):
        app = (ROOT / 'static' / 'app.js').read_text()
        update_state = re.search(
            r'function updateRunButtonState\(\)\s*\{(?P<body>[\s\S]*?)\n  \}\n  function updateRadioFieldsState',
            app,
        )
        self.assertIsNotNone(update_state)
        self.assertRegex(
            update_state.group('body'),
            r'btn\.disabled\s*=\s*(?:invalid\s*\|\|\s*isFetchingViewshed|isFetchingViewshed\s*\|\|\s*invalid)',
        )
        self.assertNotRegex(app, r'Viewshed[^\n]*already running')
        retry = app[app.index('Viewshed hit gap/outside'):]
        self.assertNotIn("$('runViewshed').click()", retry)
        self.assertNotRegex(retry, r'isRetryingViewshed\s*=\s*false;\s*continue;')

    def test_deferred_overlays_share_work_and_reject_stale_results(self):
        app = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('overlayRenderPromise', app)
        self.assertRegex(
            app,
            r'const\s+scene\s*=\s*browserSceneData[\s\S]{0,900}'
            r'(?:scene\s*!==\s*browserSceneData|browserSceneData\s*!==\s*scene)',
        )

    def test_static_release_is_an_installable_progressive_web_app(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            output = Path(tmp) / 'release'
            build(ROOT / 'data' / 'bay-area.npz', output)

            index = (output / 'index.html').read_text()
            manifest = json.loads((output / 'static' / 'manifest.webmanifest').read_text())
            service_worker = (output / 'service-worker.js').read_text()
            app = (output / 'static' / 'app.js').read_text()

            self.assertIn('rel="manifest" href="./static/manifest.webmanifest"', index)
            self.assertIn('rel="apple-touch-icon"', index)
            self.assertIn('viewport-fit=cover', index)
            self.assertEqual(manifest['display'], 'standalone')
            self.assertEqual(manifest['start_url'], '../')
            self.assertEqual(manifest['scope'], '../')
            self.assertNotIn('id', manifest)
            self.assertEqual(
                {icon['sizes'] for icon in manifest['icons']},
                {'192x192', '512x512'},
            )
            self.assertTrue((output / 'static' / 'icon-192.png').is_file())
            self.assertTrue((output / 'static' / 'icon-512.png').is_file())
            self.assertIn("navigator.serviceWorker.register('./service-worker.js', {updateViaCache: 'none'})", app)
            self.assertIn("'./static/scene.json'", service_worker)
            self.assertIn('self.skipWaiting()', service_worker)
            self.assertIn('self.clients.claim()', service_worker)
            self.assertIn('client.navigate(client.url)', service_worker)
            self.assertNotIn('__SIGHTLINE_CACHE_VERSION__', service_worker)
            self.assertIn('cache.put(APP_ENTRY, copy)', service_worker)
            self.assertNotIn("cache.put('./index.html', copy)", service_worker)

    def test_static_release_cache_revision_tracks_built_scene(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            first = Path(tmp) / 'first'
            second = Path(tmp) / 'second'
            build(ROOT / 'data' / 'bay-area.npz', first)
            build(ROOT / 'data' / 'autzen.npz', second)
            version_pattern = re.compile(r"const CACHE_NAME = 'sightline-shell-([0-9a-f]{16})'")
            first_worker = (first / 'service-worker.js').read_text()
            second_worker = (second / 'service-worker.js').read_text()
            self.assertNotEqual(
                version_pattern.search(first_worker).group(1),
                version_pattern.search(second_worker).group(1),
            )

    def test_mobile_release_uses_safe_areas_and_touch_sized_controls(self):
        css = (ROOT / 'static' / 'style.css').read_text()
        app = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('env(safe-area-inset-top)', css)
        self.assertIn('env(safe-area-inset-bottom)', css)
        self.assertRegex(css, r'@media\s*\(max-width:\s*680px\)')
        self.assertIn('(max-height: 500px) and (max-width: 950px)', css)
        self.assertIn("(max-height: 500px) and (max-width: 950px)", app)
        self.assertRegex(css, r'@media\s*\(max-width:\s*680px\)[\s\S]*?min-height:\s*44px')
        self.assertRegex(css, r'\.map-stage\s*\{[\s\S]{0,120}?order:\s*1')
        self.assertRegex(css, r'\.sidebar\s*\{[\s\S]{0,220}?order:\s*2')
        self.assertIn('height: calc(100dvh - 56px - env(safe-area-inset-top))', css)
        self.assertIn('map.invalidateSize()', app)
        narrow_mobile = css[css.index('@media (max-width: 320px)'):]
        self.assertNotIn('bottom: 254px', narrow_mobile)

    def test_mobile_release_uses_dedicated_map_setup_and_results_views(self):
        index = (ROOT / 'static' / 'index.html').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        app = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('class="mobile-nav" id="mobileNav"', index)
        self.assertIn('data-mobile-panel="map"', index)
        self.assertIn('data-mobile-panel="controls"', index)
        self.assertIn('data-mobile-panel="results"', index)
        self.assertIn('id="mobileLayersToggle"', index)
        self.assertIn('aria-controls="mapStage"', index)
        self.assertIn('aria-controls="controlsPanel"', index)
        self.assertIn('aria-controls="resultsPanel"', index)
        self.assertIn('aria-controls="mapLayerControls mapLegend"', index)
        self.assertIn('function setMobilePanel(', app)
        self.assertIn("setMobilePanel('results', true)", app)
        self.assertIn('id="resultsPanel" tabindex="-1"', index)
        self.assertIn("event.key === 'Escape'", app)
        self.assertIn("panelElement.inert =", app)
        self.assertIn("focusTarget?.focus({preventScroll:true})", app)
        self.assertRegex(
            css,
            r'body\.mobile-controls-open\s+\.sidebar\s*\{[\s\S]{0,80}?display:\s*block',
        )
        self.assertRegex(
            css,
            r'body\.mobile-results-open\s+\.results-panel\s*\{[\s\S]{0,80}?display:\s*block',
        )
        self.assertIn('body.mobile-controls-open #map', css)
        self.assertIn('body.mobile-results-open #map', css)
        self.assertRegex(
            css,
            r'@media\s*\(max-width:\s*680px\)[\s\S]*?\.results-panel\s*\{'
            r'[\s\S]{0,260}?display:\s*none',
        )
        self.assertRegex(css, r'\.mobile-nav\s*\{[\s\S]{0,260}?position:\s*fixed')

    def test_mobile_map_chrome_is_compact_until_layers_are_opened(self):
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertRegex(
            css,
            r'\.map-tools:not\(\.expanded\)\s*>\s*:not\(\.mobile-layers-toggle\)'
            r'\s*\{[\s\S]{0,60}?display:\s*none',
        )
        self.assertRegex(
            css,
            r'\.map-tools\.expanded\s*\+\s*\.legend\s*\{[\s\S]{0,80}?display:\s*flex',
        )
        self.assertIn('left: env(safe-area-inset-left)', css)
        self.assertIn('right: env(safe-area-inset-right)', css)
        self.assertIn('right: max(8px, env(safe-area-inset-right))', css)

    def test_ad_slot_is_in_document_flow_instead_of_loading_overlay(self):
        index = (ROOT / 'static' / 'index.html').read_text()
        loading = re.search(
            r'<div class="loading"[\s\S]*?</div>\s*<section class="results-panel"',
            index,
        )
        self.assertIsNotNone(loading)
        self.assertNotIn('ad-placeholder', loading.group(0))
        self.assertIn('class="content-ad" id="contentAd" hidden', index)


if __name__ == '__main__':
    unittest.main()
