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


if __name__ == '__main__':
    unittest.main()
