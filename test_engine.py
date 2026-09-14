import unittest
import numpy as np
from engine import Scene, trace, settings, intervals, viewshed


def scene(w=100,h=10,res=1):
    ground=np.zeros((h,w),dtype=np.float32)
    empty=np.full_like(ground,np.nan)
    return Scene(ground,empty.copy(),empty.copy(),empty.copy(),np.zeros((h,w,3),dtype=np.uint8),dict(resolution_m=res,xmin=500000,ymax=4900000,crs='EPSG:32610'))


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.s=scene(); self.a=(500000.5,4899995.5); self.b=(500099.5,4899995.5)
        self.opts=settings({})

    def test_flat_clear(self):
        r=trace(self.s,self.a,self.b,self.opts)
        self.assertEqual(r['status'],'clear'); self.assertAlmostEqual(r['distance_m'],99)
        self.assertEqual(r['foliage_m'],0); self.assertGreater(r['min_clearance_m'],9.99)

    def test_one_cell_building_block_and_raise(self):
        self.s.buildings[4,50]=15
        self.assertEqual(trace(self.s,self.a,self.b,self.opts)['status'],'blocked')
        self.opts.update(height_a=25,height_b=25)
        self.assertEqual(trace(self.s,self.a,self.b,self.opts)['status'],'clear')

    def test_tree_attenuation_and_optical(self):
        self.s.trees[4,40:60]=20
        r=trace(self.s,self.a,self.b,self.opts)
        self.assertEqual(r['status'],'foliage'); self.assertAlmostEqual(r['foliage_m'],20)
        self.assertAlmostEqual(r['foliage_loss_db'],4)
        self.opts['mode']='optical'
        self.assertEqual(trace(self.s,self.a,self.b,self.opts)['status'],'blocked')

    def test_foliage_disabled_excludes_canopy_from_optical_path(self):
        self.s.trees[4,40:60]=20
        result=trace(self.s,self.a,self.b,settings({
            'mode':'optical','height_a':10,'height_b':10,'include_foliage':False
        }))
        self.assertEqual(result['status'],'clear')
        self.assertEqual(result['foliage_m'],0)

    def test_canopy_source_uncertainty_only_affects_foliage_enabled_paths(self):
        self.s.canopy_uncertain=np.ones(self.s.ground.shape,dtype=bool)
        included=trace(self.s,self.a,self.b,settings({
            'mode':'optical','height_a':10,'height_b':10,'include_foliage':True
        }))
        excluded=trace(self.s,self.a,self.b,settings({
            'mode':'optical','height_a':10,'height_b':10,'include_foliage':False
        }))
        self.assertEqual(included['status'],'unknown')
        self.assertEqual(excluded['status'],'clear')

    def test_slope_partial_canopy(self):
        self.s.trees[:]=15
        self.opts.update(height_a=10,height_b=20)
        r=trace(self.s,self.a,self.b,self.opts)
        self.assertAlmostEqual(r['foliage_m'],np.hypot(99,10)/2,delta=.002)

    def test_unknown_data(self):
        self.s.ground[4,50]=np.nan
        self.assertEqual(trace(self.s,self.a,self.b,self.opts)['status'],'unknown')
        self.s.ground[4,50]=0; self.s.unknown[4,50]=30
        self.assertEqual(trace(self.s,self.a,self.b,self.opts)['status'],'unknown')

    def test_curvature_beyond_ten_km(self):
        s=scene(w=200,h=1,res=100)
        a=(500050,4899950); b=(519950,4899950)
        o=settings({'height_a':1,'height_b':1,'mode':'optical'})
        self.assertEqual(trace(s,a,b,o)['status'],'blocked')
        o.update(height_a=20,height_b=20)
        self.assertEqual(trace(s,a,b,o)['status'],'clear')

    def test_reverse_and_diagonal(self):
        a=(500000.2,4899999.2); b=(500099.8,4899990.2)
        self.s.trees[3:8,20:50]=20
        self.assertAlmostEqual(trace(self.s,a,b,self.opts)['foliage_m'],trace(self.s,b,a,self.opts)['foliage_m'])
        lo,hi,r,c=intervals(self.s,a,b)
        self.assertAlmostEqual(sum(hi-lo),1)
        self.assertTrue(np.all(hi>lo))

    def test_fresnel_separate(self):
        self.s.buildings[4,50]=9.9
        r=trace(self.s,self.a,self.b,self.opts)
        self.assertEqual(r['direct_status'],'clear'); self.assertEqual(r['status'],'fresnel'); self.assertLess(r['min_fresnel_clearance_m'],0)

    def test_unknown_in_fresnel_envelope(self):
        self.s.unknown[4,50]=9.9
        r=trace(self.s,self.a,self.b,self.opts)
        self.assertEqual(r['direct_status'],'clear')
        self.assertEqual(r['status'],'unknown')
        self.assertIsNone(r['min_fresnel_clearance_m'])

    def test_radio_viewshed_exposes_fresnel_constraint(self):
        lon,lat=self.s.to_ll.transform(500050,4899995)
        r=viewshed(self.s,{'a':[lat,lon],'radius_m':20,'step_m':5,'height_a':.1,'height_b':.1,'frequency_mhz':10})
        self.assertGreater(r['counts']['fresnel'],0)

    def test_optical_ignores_unused_radio_fields(self):
        o=settings({'mode':'optical','frequency_mhz':None,'foliage_db_m':None,'k_factor':None})
        self.assertEqual(o['k_factor'],1)

    def test_outside_and_invalid(self):
        with self.assertRaises(ValueError): trace(self.s,self.a,self.a,self.opts)
        with self.assertRaises(ValueError): trace(self.s,self.a,(1,1),self.opts)
        for value in (float('nan'),-1,0):
            with self.assertRaises(ValueError): settings({'frequency_mhz':value})

    def test_viewshed_coverage_and_limits(self):
        lon,lat=self.s.to_ll.transform(*self.a)
        r=viewshed(self.s,{'a':[lat,lon],'radius_m':20,'step_m':5})
        self.assertGreater(r['counts']['unknown'],0)
        self.assertGreater(r['counts']['clear'],0)
        with self.assertRaises(ValueError): viewshed(self.s,{'a':[lat,lon],'radius_m':1000,'step_m':1})

    def test_viewshed_rejects_grid_above_responsive_limit(self):
        lon,lat=self.s.to_ll.transform(*self.a)
        with self.assertRaisesRegex(ValueError, 'at least 2 m'):
            viewshed(self.s, {'a':[lat,lon], 'radius_m':51, 'step_m':1})

    def test_rf_link_budget_and_viability(self):
        opts = settings({
            'mode': 'radio',
            'frequency_mhz': 5800,
            'tx_power_dbm': 24,
            'antenna_gain_a_dbi': 23,
            'antenna_gain_b_dbi': 23,
            'cable_loss_a_db': 1,
            'cable_loss_b_db': 1,
            'channel_width_mhz': 40,
            'rx_sensitivity_dbm': -79,
        })
        r = trace(self.s, self.a, self.b, opts)
        lb = r['link_budget']
        self.assertIsNotNone(lb)
        self.assertAlmostEqual(lb['eirp_dbm'], 46.0) # 24 - 1 + 23
        # 99m at 5800 MHz: FSPL ~ 87.6 dB
        self.assertGreater(lb['free_space_loss_db'], 85.0)
        self.assertLess(lb['free_space_loss_db'], 90.0)
        # RSL = EIRP (46) - FSPL (~87.6) - 1 + 23 = ~ -19.6 dBm
        self.assertGreater(lb['rx_power_dbm'], -25.0)
        self.assertGreater(lb['link_margin_db'], 50.0) # > 50 dB margin at 99m!
        self.assertEqual(r['viability'], 'viable')

        # Test deficit condition with tiny tx power and high attenuation
        deficit_opts = settings({
            'mode': 'radio',
            'frequency_mhz': 5800,
            'tx_power_dbm': -10,
            'antenna_gain_a_dbi': 0,
            'antenna_gain_b_dbi': 0,
            'cable_loss_a_db': 10,
            'cable_loss_b_db': 10,
            'rx_sensitivity_dbm': -60,
        })
        r_def = trace(self.s, self.a, self.b, deficit_opts)
        self.assertEqual(r_def['viability'], 'deficit')
        self.assertLess(r_def['link_budget']['link_margin_db'], 0.0)

    def test_rooftop_mount_elevation(self):
        # Cell at A is (4, 0)
        r_a, c_a = self.s.cell(*self.a)
        self.s.buildings[r_a, c_a] = 30.0 # 30 m building roof
        # AGL mount
        r_agl = trace(self.s, self.a, self.b, settings({'height_a': 10, 'mount_type_a': 'agl'}))
        self.assertEqual(r_agl['mounts']['a']['total_elevation_m'], 10.0)
        self.assertEqual(r_agl['mounts']['a']['mount_type'], 'agl')

        # Rooftop mount
        r_roof = trace(self.s, self.a, self.b, settings({'height_a': 10, 'mount_type_a': 'rooftop'}))
        self.assertEqual(r_roof['mounts']['a']['total_elevation_m'], 40.0) # 30 + 10
        self.assertEqual(r_roof['mounts']['a']['mount_type'], 'rooftop')
        self.assertEqual(r_roof['mounts']['a']['structure_height_m'], 30.0)

    def test_rooftop_origin_can_leave_its_own_footprint(self):
        self.s.buildings[4, 0:12] = 30.0
        result = trace(self.s, self.a, self.b, settings({
            'height_a': 5,
            'height_b': 5,
            'mount_type_a': 'rooftop',
            'mode': 'optical',
        }))
        self.assertEqual(result['status'], 'clear')
        self.s.buildings[4, 30] = 30.0
        self.assertEqual(trace(self.s, self.a, self.b, settings({
            'height_a': 5,
            'height_b': 5,
            'mount_type_a': 'rooftop',
            'mode': 'optical',
        }))['status'], 'blocked')

    def test_rooftop_origin_descending_ray_cannot_cross_own_building(self):
        self.s.buildings[4, 0:20] = 30.0
        result = trace(self.s, self.a, self.b, settings({
            'height_a': 5,
            'height_b': .1,
            'mount_type_a': 'rooftop',
            'mode': 'optical',
        }))
        self.assertEqual(result['status'], 'blocked')

    def test_alignment_azimuth_and_tilt(self):
        r = trace(self.s, self.a, self.b, self.opts)
        align = r['alignment']
        self.assertIn('azimuth_a_to_b', align)
        self.assertIn('azimuth_b_to_a', align)
        # Since A=(500000.5, y) and B=(500099.5, y), A is due West of B, azimuth A->B is ~90 deg
        self.assertAlmostEqual(align['azimuth_a_to_b'], 90.0, delta=2.0)
        self.assertAlmostEqual(align['azimuth_b_to_a'], 270.0, delta=2.0)
        self.assertAlmostEqual(r['distance_3d_m'], 99.0, delta=0.5)

    def test_critical_obstacle_and_mast_height(self):
        self.s.buildings[4, 50] = 15.0 # 15 m obstacle in middle
        r = trace(self.s, self.a, self.b, settings({'height_a': 10, 'height_b': 10}))
        self.assertEqual(r['status'], 'blocked')
        crit = r['critical_obstacle']
        self.assertIsNotNone(crit)
        self.assertEqual(crit['obstacle_type'], 'building')
        self.assertEqual(crit['obstacle_elevation_m'], 15.0)
        self.assertLess(crit['clearance_m'], 0.0)
        # Required height to clear direct obstacle should be >= 5 m
        self.assertGreater(crit['required_clearance_height_both_m'], 4.9)

    def test_critical_obstacle_terrain_ridge_with_trees(self):
        # Ground ridge rises to 50m in middle with 60m tree canopy on top
        self.s.ground[4, 45:55] = 50.0
        self.s.trees[4, 45:55] = 60.0
        # Antenna heights 10m on flat ground (0m elevation) -> ray at middle is ~10m, deep in 50m ground
        r = trace(self.s, self.a, self.b, settings({'height_a': 10, 'height_b': 10}))
        self.assertEqual(r['status'], 'blocked')
        crit = r['critical_obstacle']
        self.assertIsNotNone(crit)
        # Must be classified as terrain, NOT tree!
        self.assertEqual(crit['obstacle_type'], 'terrain')
        self.assertEqual(crit['obstacle_elevation_m'], 50.0)
        self.assertLess(crit['clearance_m'], -35.0)

    def test_critical_obstacle_tree_canopy_optical_clear_ground(self):
        # Ground is 0m everywhere, tree canopy is at 25m in the middle
        self.s.trees[4, 48:52] = 25.0
        # In optical mode, ray at 20m enters the tree canopy (20m > 0m ground, but <= 25m tree)
        r = trace(self.s, self.a, self.b, settings({'mode': 'optical', 'height_a': 20, 'height_b': 20}))
        self.assertEqual(r['status'], 'blocked')
        crit = r['critical_obstacle']
        self.assertIsNotNone(crit)
        # Must be classified as tree
        self.assertEqual(crit['obstacle_type'], 'tree')
        self.assertEqual(crit['obstacle_elevation_m'], 25.0)
        self.assertLess(crit['clearance_m'], 0.0)
        self.assertGreater(crit['required_clearance_height_both_m'], 4.5)


    def test_viewshed_missing_site_a(self):
        with self.assertRaises(ValueError) as ctx:
            viewshed(self.s, {})
        self.assertIn('Site A coordinates', str(ctx.exception))

    def test_viewshed_site_a_outside_and_corridor_gap(self):
        # Point outside scene coverage
        with self.assertRaises(ValueError) as ctx:
            viewshed(self.s, {'a': [0.0, 0.0], 'radius_m': 20, 'step_m': 5})
        self.assertIn('outside measured terrain coverage', str(ctx.exception))

        # Corridor scene where Site A is in gap
        corridor_scene = scene()
        corridor_scene.meta['is_corridor'] = True
        corridor_scene.ground[4, 50] = np.nan
        lon, lat = corridor_scene.to_ll.transform(500050.5, 4899995.5)
        with self.assertRaises(ValueError) as ctx:
            viewshed(corridor_scene, {'a': [lat, lon], 'radius_m': 20, 'step_m': 5})
        self.assertIn('corridor', str(ctx.exception))

    def test_viewshed_target_agl_vs_height_b(self):
        # 100x100 scene with a 15m building obstacle
        s = scene(w=100, h=100, res=1)
        s.buildings[40:60, 55:58] = 15.0
        lon_a, lat_a = s.to_ll.transform(500050.5, 4899950.5)
        # target_agl=2m is blocked by 15m obstacle
        r_low = viewshed(s, {'a': [lat_a, lon_a], 'radius_m': 30, 'step_m': 5, 'height_a': 10, 'target_agl': 2.0})
        # target_agl=30m clears above 15m obstacle
        r_high = viewshed(s, {'a': [lat_a, lon_a], 'radius_m': 30, 'step_m': 5, 'height_a': 10, 'target_agl': 30.0})
        self.assertIn('Receiver height is 2.0 m above local ground', r_low['notes'][0])
        self.assertIn('Receiver height is 30.0 m above local ground', r_high['notes'][0])
        self.assertGreater(r_high['counts']['clear'], r_low['counts']['clear'])
        self.assertLess(r_high['counts']['blocked'], r_low['counts']['blocked'])

    def test_viewshed_simple_vs_full_and_foliage_toggle(self):
        import base64, io
        from PIL import Image
        lon_a, lat_a = self.s.to_ll.transform(500050.5, 4899995.5)
        self.s.trees[4, 40:60] = 5.0

        # Simple mode with foliage included (default)
        r_simple = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 20, 'step_m': 5, 'simple': True, 'include_foliage': True})
        img_simple = np.array(Image.open(io.BytesIO(base64.b64decode(r_simple['image'].split(',')[1]))))
        simple_colors = np.unique(img_simple.reshape(-1, 4), axis=0).tolist()
        # Red hit color [235, 55, 65, 215] must be present
        self.assertIn([235, 55, 65, 215], simple_colors)

        # Simple mode with foliage excluded (foliage as transparent/blocked)
        r_no_foliage = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 20, 'step_m': 5, 'simple': True, 'include_foliage': False})
        self.assertIsNotNone(r_no_foliage['image'])

        # Full mode
        r_full = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 20, 'step_m': 5, 'simple': False})
        img_full = np.array(Image.open(io.BytesIO(base64.b64decode(r_full['image'].split(',')[1]))))
        full_colors = np.unique(img_full.reshape(-1, 4), axis=0).tolist()
        # Full mode colors: visible clear is [235, 55, 65, 215]
        self.assertIn([235, 55, 65, 215], full_colors)

        # Custom colors override
        r_custom = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 20, 'step_m': 5, 'colors': {'clear': [11, 22, 33, 44]}})
        img_custom = np.array(Image.open(io.BytesIO(base64.b64decode(r_custom['image'].split(',')[1]))))
        custom_colors = np.unique(img_custom.reshape(-1, 4), axis=0).tolist()
        self.assertIn([11, 22, 33, 44], custom_colors)

    def test_viewshed_large_radius_and_bounds(self):
        lon_a, lat_a = self.s.to_ll.transform(500050.5, 4899995.5)
        r = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 50, 'step_m': 2})
        self.assertIsNotNone(r['image'])
        self.assertEqual(len(r['bounds']), 2)
        total_pts = sum(r['counts'].values())
        self.assertGreater(total_pts, 1000)

    def test_viewshed_keeps_dateline_bounds_local_to_origin(self):
        h=w=200
        ground=np.zeros((h,w),dtype=np.float32)
        empty=np.full_like(ground,np.nan)
        dateline=Scene(ground,empty.copy(),empty.copy(),empty.copy(),np.zeros((h,w,3),dtype=np.uint8),dict(
            resolution_m=1,xmin=0,ymax=h,
            crs='+proj=tmerc +lat_0=0 +lon_0=179.9999 +k=1 +x_0=100 +y_0=100 +datum=WGS84 +units=m +no_defs'
        ))
        result=viewshed(dateline,{'a':[0,179.9999],'radius_m':50,'step_m':5})
        self.assertLess(result['bounds'][1][1]-result['bounds'][0][1],.01)

    def test_trace_fast_path_detailed_false(self):
        r_full = trace(self.s, self.a, self.b, self.opts, detailed=True)
        r_fast = trace(self.s, self.a, self.b, self.opts, detailed=False)
        self.assertEqual(r_fast['status'], r_full['status'])
        self.assertEqual(r_fast['direct_status'], r_full['direct_status'])
        self.assertEqual(r_fast['foliage_m'], r_full['foliage_m'])
        self.assertNotIn('alignment', r_fast)
        self.assertNotIn('link_budget', r_fast)
        self.assertNotIn('critical_obstacle', r_fast)

    def test_viewshed_target_surface_modes(self):
        # Place a building in the scene
        r_b, c_b = self.s.cell(500060.5, 4899995.5)
        self.s.buildings[r_b, c_b] = 25.0
        lon_a, lat_a = self.s.to_ll.transform(500050.5, 4899995.5)
        # Test surface mode vs ground mode
        r_surf = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 25, 'step_m': 5, 'height_a': 30, 'target_agl': 2, 'target_surface': 'surface'})
        r_gnd = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 25, 'step_m': 5, 'height_a': 30, 'target_agl': 2, 'target_surface': 'ground'})
        r_default = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 25, 'step_m': 5, 'height_a': 30, 'target_agl': 2})
        # Default should match ground mode
        self.assertEqual(r_default['counts']['clear'], r_gnd['counts']['clear'])
        self.assertEqual(r_default['counts']['blocked'], r_gnd['counts']['blocked'])
        self.assertGreaterEqual(r_surf['counts']['clear'], r_gnd['counts']['clear'])

    def test_viewshed_blocked_toggle(self):
        import base64, io
        from PIL import Image
        lon_a, lat_a = self.s.to_ll.transform(500050.5, 4899995.5)
        # With blocked included
        r_with_blk = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 20, 'step_m': 5, 'include_blocked': True, 'simple': False})
        img_with = np.array(Image.open(io.BytesIO(base64.b64decode(r_with_blk['image'].split(',')[1]))))
        colors_with = np.unique(img_with.reshape(-1, 4), axis=0).tolist()
        # With blocked excluded
        r_no_blk = viewshed(self.s, {'a': [lat_a, lon_a], 'radius_m': 20, 'step_m': 5, 'include_blocked': False, 'simple': False})
        img_no = np.array(Image.open(io.BytesIO(base64.b64decode(r_no_blk['image'].split(',')[1]))))
        colors_no = np.unique(img_no.reshape(-1, 4), axis=0).tolist()
        # Red blocked color [234, 85, 100, 160] should not be in colors_no
        self.assertNotIn([234, 85, 100, 160], colors_no)

    def test_viewshed_no_building_footprint_red_when_ground(self):
        import base64, io
        from PIL import Image
        s = scene(w=60, h=60, res=1)
        # Put two buildings: one short (1.8m) and one tall (15m)
        s.buildings[25:35, 25:35] = 1.8
        s.buildings[40:50, 40:50] = 15.0
        lon_a, lat_a = s.to_ll.transform(500010.5, 4899990.5)

        # Ground mode with target_agl=20m (taller than all buildings)
        r_gnd = viewshed(s, {
            'a': [lat_a, lon_a], 'radius_m': 45, 'step_m': 1,
            'height_a': 40, 'target_agl': 20.0, 'target_surface': 'ground', 'simple': True
        })
        img_data = base64.b64decode(r_gnd['image'].split(',')[1])
        img = np.array(Image.open(io.BytesIO(img_data)))
        red_mask = (img[:, :, 0] == 235) & (img[:, :, 1] == 55) & (img[:, :, 2] == 65)

        # Coordinate grid
        corners = [s.to_ll.transform(500010.5+dx*45, 4899990.5+dy*45) for dx in (-1,1) for dy in (-1,1)]
        west = min(v[0] for v in corners); east = max(v[0] for v in corners)
        south = min(v[1] for v in corners); north = max(v[1] for v in corners)
        n = img.shape[0]
        lon = west + (np.arange(n) + 0.5) / n * (east - west)
        lat = north - (np.arange(n) + 0.5) / n * (north - south)
        xx, yy = s.to_xy.transform(*np.meshgrid(lon, lat))

        red_on_bldg = 0
        for r, c in zip(*np.where(red_mask)):
            bx, by = float(xx[r, c]), float(yy[r, c])
            br, bc = s.cell(bx, by)
            if 0 <= br < s.h and 0 <= bc < s.w and np.isfinite(s.buildings[br, bc]):
                red_on_bldg += 1
        self.assertEqual(red_on_bldg, 0, "No building footprint should be red when target_surface='ground'")

        # Surface mode: clear rooftops MUST be illuminated red
        r_surf = viewshed(s, {
            'a': [lat_a, lon_a], 'radius_m': 45, 'step_m': 1,
            'height_a': 40, 'target_agl': 2.0, 'target_surface': 'surface', 'simple': True
        })
        img_surf = np.array(Image.open(io.BytesIO(base64.b64decode(r_surf['image'].split(',')[1]))))
        red_surf = (img_surf[:, :, 0] == 235) & (img_surf[:, :, 1] == 55) & (img_surf[:, :, 2] == 65)
        red_surf_bldg = 0
        for r, c in zip(*np.where(red_surf)):
            bx, by = float(xx[r, c]), float(yy[r, c])
            br, bc = s.cell(bx, by)
            if 0 <= br < s.h and 0 <= bc < s.w and np.isfinite(s.buildings[br, bc]):
                red_surf_bldg += 1
        self.assertGreater(red_surf_bldg, 0, "Rooftops should be illuminated red when target_surface='surface'")

    def test_viewshed_coarse_resolution_default_step(self):
        s_coarse = scene(w=20, h=20, res=50)
        lon_a, lat_a = s_coarse.to_ll.transform(500500, 4899500)
        # Should NOT raise ValueError when step_m is omitted for res=50
        r = viewshed(s_coarse, {'a': [lat_a, lon_a], 'radius_m': 200})
        self.assertIsNotNone(r['image'])
        self.assertGreater(sum(r['counts'].values()), 0)

    def test_viewshed_auto_rooftop_a(self):
        s = scene(w=50, h=50, res=1)
        r_a, c_a = s.cell(500025.5, 4899975.5)
        s.buildings[r_a, c_a] = 30.0 # 30m building at site A
        lon_a, lat_a = s.to_ll.transform(500025.5, 4899975.5)

        # Default: auto_rooftop triggers
        r_def = viewshed(s, {'a': [lat_a, lon_a], 'radius_m': 10, 'step_m': 2, 'height_a': 5})
        # If auto_rooftop worked, site A at 30+5=35m can see surrounding flat ground at 0+2=2m
        self.assertGreater(r_def['counts']['clear'], 0)

        # Explicit auto_rooftop_a=False and mount_type_a='agl':
        # Observer is placed at ground inside 30m building (z0=5m), so surrounding viewshed is 100% blocked
        r_agl = viewshed(s, {'a': [lat_a, lon_a], 'radius_m': 10, 'step_m': 2, 'height_a': 5, 'mount_type_a': 'agl', 'auto_rooftop_a': False})
        self.assertEqual(r_agl['counts']['clear'], 0)

    def test_shadow_behind_building(self):
        # Observer at (0.5, y) height 30m
        # Building at x=50, height 20m
        # Target at ground height 2m
        # Grazing ray from (0.5, 30) through (50.5, 20) hits 2m at x ~ 141m
        s = scene(w=200, h=3, res=1)
        s.buildings[:, 50] = 20.0
        a = (500000.5, 4899998.5)
        opts = settings({'height_a': 30.0, 'height_b': 2.0, 'k_factor': 1.0, 'mode': 'optical'})

        # In front of building: clear
        self.assertEqual(trace(s, a, (500040.5, 4899998.5), opts, detailed=False)['status'], 'clear')
        # Deep in shadow of building: blocked
        self.assertEqual(trace(s, a, (500080.5, 4899998.5), opts, detailed=False)['status'], 'blocked')
        # Beyond shadow horizon (x > 142m): clear
        self.assertEqual(trace(s, a, (500160.5, 4899998.5), opts, detailed=False)['status'], 'clear')


if __name__=='__main__': unittest.main()
