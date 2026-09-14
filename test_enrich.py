import unittest
import numpy as np
from enrich import fuse_layers
from buildings import polygons

class EnrichmentTests(unittest.TestCase):
    def test_building_max_roof_and_missing_height(self):
        g=np.zeros((2,4),dtype=np.float32);empty=np.full_like(g,np.nan)
        unknown=empty.copy();unknown[0,0]=12
        labels=np.array([[1,1,2,2],[1,1,2,2]],dtype=np.int32)
        b,t,u,q,_=fuse_layers(g,empty,empty,unknown,labels,empty)
        np.testing.assert_array_equal(b[:,:2],12)
        self.assertTrue(np.isnan(u[0,0]));self.assertTrue(q[:,2:].all())

    def test_canopy_labels_unclassified_returns_but_not_buildings(self):
        g=np.zeros((1,4));b=np.array([[8,np.nan,np.nan,np.nan]])
        trees=np.full_like(g,np.nan);u=np.array([[np.nan,12,25,np.nan]])
        canopy=np.full_like(g,20);labels=np.zeros((1,4),dtype=np.int32)
        bb,t,uu,q,_=fuse_layers(g,b,trees,u,labels,canopy)
        self.assertTrue(np.isnan(t[0,0]));self.assertEqual(bb[0,0],8)
        self.assertTrue(np.isnan(uu[0,1]));self.assertTrue(np.isnan(uu[0,2]));self.assertEqual(t[0,2],25)
        self.assertEqual(t[0,3],20)

    def test_missing_canopy_is_reported_separately_from_building_uncertainty(self):
        g=np.zeros((1,3),dtype=np.float32)
        empty=np.full_like(g,np.nan)
        result=fuse_layers(g,empty,empty,empty,np.zeros((1,3),dtype=np.int32),empty)
        self.assertFalse(result[3].any())
        self.assertTrue(result[-1].all())

    def test_footprint_courtyard_preserved(self):
        def ring(coords):return [{'lon':x,'lat':y} for x,y in coords]
        e={'type':'relation','tags':{'building':'yes'},'members':[
            {'role':'outer','geometry':ring([(0,0),(4,0),(4,4),(0,4),(0,0)])},
            {'role':'inner','geometry':ring([(1,1),(3,1),(3,3),(1,3),(1,1)])}]}
        p=polygons([e]);self.assertEqual(len(p),1);self.assertAlmostEqual(p[0].area,12)

if __name__=='__main__':unittest.main()
