#!/usr/bin/env python3
"""Build Sightline's no-server global browser release with a starter scene."""
import argparse
from html import escape as html_escape
import json
from pathlib import Path
import shutil
from urllib.parse import urlparse

from engine import Scene, map_image, scene_manifest


ROOT = Path(__file__).resolve().parent


def build(scene_path, output, base_url=''):
    scene_path = Path(scene_path).resolve()
    output = Path(output).resolve()
    if output in (ROOT, ROOT.parent) or ROOT not in output.parents:
        raise ValueError('Static output must be a child directory of the Sightline app.')
    if output.exists():
        shutil.rmtree(output)
    static_output = output / 'static'
    shutil.copytree(ROOT / 'static', static_output)
    (static_output / 'index.html').unlink()

    scene = Scene.load(scene_path)
    manifest = scene_manifest(scene)
    (static_output / 'scene.json').write_text(
        json.dumps(manifest, allow_nan=False, separators=(',', ':')),
        encoding='utf-8',
    )
    (static_output / 'scene-terrain.png').write_bytes(map_image(scene))
    (static_output / 'scene-classes.png').write_bytes(map_image(scene, classes=True))

    page = (ROOT / 'static' / 'index.html').read_text(encoding='utf-8')
    page = page.replace(
        '<script src="./static/app.js"></script>',
        '<script>window.SIGHTLINE_STATIC = true;</script>\n  <script src="./static/app.js"></script>',
    )
    if base_url:
        url = base_url.rstrip('/') + '/'
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc:
            raise ValueError('--base-url must be an absolute HTTP or HTTPS URL.')
        safe_url = html_escape(url, quote=True)
        tags = f'  <link rel="canonical" href="{safe_url}">\n  <meta property="og:url" content="{safe_url}">\n'
        page = page.replace('</head>', tags + '</head>')
        page = page.replace(
            'content="/static/favicon.svg"',
            f'content="{safe_url}static/favicon.svg"',
        )
    (output / 'index.html').write_text(page, encoding='utf-8')
    shutil.copy2(ROOT / 'static' / 'robots.txt', output / 'robots.txt')
    shutil.copy2(ROOT / 'LICENSE', output / 'LICENSE')
    shutil.copy2(ROOT / 'THIRD_PARTY_NOTICES.md', output / 'THIRD_PARTY_NOTICES.md')
    (output / '_headers').write_text(
        '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: geolocation=(self)\n\n/static/scene.json\n  Cache-Control: public, max-age=3600\n\n/static/*.js\n  Cache-Control: public, max-age=3600\n\n/static/*.css\n  Cache-Control: public, max-age=3600\n',
        encoding='utf-8',
    )
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scene', default=str(ROOT / 'data' / 'bay-area.npz'))
    parser.add_argument('--output', default=str(ROOT / 'dist'))
    parser.add_argument('--base-url', default='', help='Optional public URL for canonical/Open Graph tags')
    args = parser.parse_args()
    built = build(args.scene, args.output, args.base_url)
    print(f'Built static release: {built}')
