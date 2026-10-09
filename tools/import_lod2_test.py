"""Tests for tools/import_lod2.py: CityGML parsing, ridge direction from roof surfaces, matching, BLS1."""
from __future__ import annotations

import math
import unittest

import numpy as np

import import_lod2 as lod
from bake_osm_buildings import Building


def pos(points):
    return ' '.join(f'{x} {y} {z}' for x, y, z in points)


def gml_building(gid: str, roof_type: int, ground: float, ridge: float, eave: float, footprint, roofs) -> str:
    """A minimal bldg:Building chunk in the Bavarian LoD2 layout."""
    roof_xml = ''.join(
        f'<bldg:boundedBy><bldg:RoofSurface gml:id="{gid}_r{i}"><gml:posList>{pos(r)}</gml:posList>'
        f'</bldg:RoofSurface></bldg:boundedBy>' for i, r in enumerate(roofs))
    return (f'<bldg:Building gml:id="{gid}">'
            f'<gen:stringAttribute name="HoeheDach">\n<gen:value>{ridge}</gen:value></gen:stringAttribute>'
            f'<gen:stringAttribute name="HoeheGrund">\n<gen:value>{ground}</gen:value></gen:stringAttribute>'
            f'<gen:stringAttribute name="NiedrigsteTraufeDesGebaeudes">\n<gen:value>{eave}</gen:value></gen:stringAttribute>'
            f'<bldg:roofType>{roof_type}</bldg:roofType>'
            f'<bldg:boundedBy><bldg:GroundSurface gml:id="{gid}_g"><gml:posList>{pos(footprint)}</gml:posList>'
            f'</bldg:GroundSurface></bldg:boundedBy>{roof_xml}</bldg:Building>')


def gable(x0, y0, length=12.0, width=8.0, ground=700.0, eave=705.0, ridge=709.0):
    """A gable along x (ridge east-west) over [x0, x0+length] x [y0, y0+width]."""
    ym = y0 + width / 2
    fp = [(x0, y0, ground), (x0 + length, y0, ground), (x0 + length, y0 + width, ground), (x0, y0 + width, ground), (x0, y0, ground)]
    south = [(x0, y0, eave), (x0 + length, y0, eave), (x0 + length, ym, ridge), (x0, ym, ridge), (x0, y0, eave)]
    north = [(x0, ym, ridge), (x0 + length, ym, ridge), (x0 + length, y0 + width, eave), (x0, y0 + width, eave), (x0, ym, ridge)]
    return fp, [south, north]


class Parse(unittest.TestCase):
    def test_a_gable(self):
        fp, roofs = gable(657000, 5261000)
        got = lod.parse_lod2(('<core:CityModel>' + gml_building('B1', 3100, 700, 709, 705, fp, roofs)).encode())
        self.assertEqual(len(got), 1)
        b = got[0]
        self.assertEqual((b['adv'], b['form']), (3100, lod.GABLED))
        self.assertAlmostEqual(b['ridge'], 9.0)
        self.assertAlmostEqual(b['eave'], 5.0)
        self.assertAlmostEqual(b['area'], 96.0)
        # Ridge east-west: compass 90 (mod 180).
        self.assertAlmostEqual(b['azimuth'] % 180, 90.0, delta=0.5)

    def test_mixed_roof_has_no_form(self):
        fp, roofs = gable(0, 0)
        b = lod.parse_lod2(gml_building('B2', 5000, 700, 709, 705, fp, roofs).encode())[0]
        self.assertEqual(b['form'], 0)

    def test_parts_without_height_attributes(self):
        """Brandenburg and Berlin: parts under a parent that has only the function, heights off the coordinates."""
        def part(gid, roof_type, fp, roofs):
            surfaces = ''.join(
                f'<bldg:boundedBy><bldg:{kind} gml:id="{gid}_{i}"><gml:posList srsDimension="3">{pos(r)}</gml:posList>'
                f'</bldg:{kind}></bldg:boundedBy>'
                for i, (kind, r) in enumerate([('GroundSurface', fp)] + [('RoofSurface', r) for r in roofs]))
            return (f'<bldg:consistsOfBuildingPart><bldg:BuildingPart gml:id="{gid}">'
                    f'<bldg:roofType>{roof_type}</bldg:roofType>{surfaces}</bldg:BuildingPart></bldg:consistsOfBuildingPart>')
        house_fp, house_roofs = gable(368000, 5807000, ground=30.0, eave=36.0, ridge=40.5)
        wing_fp, _ = gable(368012, 5807000, length=6.0, ground=30.0)
        wing_roof = [[(x, y, 33.0) for x, y, _z in wing_fp]]
        gml = ('<core:CityModel><bldg:Building gml:id="DEBBAL010009e6j7"><bldg:function>31001_1010</bldg:function>'
               + part('DEBBAL010009e6j7_p1', 3100, house_fp, house_roofs)
               + part('DEBBAL010009e6j7_p2', 1000, wing_fp, wing_roof) + '</bldg:Building></core:CityModel>')
        got = lod.parse_lod2(gml.encode())
        self.assertEqual(len(got), 2, 'one per part, none for the bare parent')
        house, wing = got
        self.assertEqual((house['form'], house['function']), (lod.GABLED, '31001_1010'))
        self.assertAlmostEqual(house['ridge'], 10.5)
        self.assertAlmostEqual(house['eave'], 6.0)
        self.assertEqual((wing['form'], wing['function']), (lod.FLAT, '31001_1010'))
        self.assertAlmostEqual(wing['ridge'], 3.0)
        self.assertAlmostEqual(wing['eave'], 3.0)


class Kinds(unittest.TestCase):
    def test_functions(self):
        self.assertEqual(lod.kind_of_function('31001_1000', 120), lod.KIND_HOUSE)
        self.assertEqual(lod.kind_of_function('31001_1000', 600), lod.KIND_RESIDENTIAL)
        self.assertEqual(lod.kind_of_function('31001_2463', 30), lod.KIND_SMALL)
        self.assertEqual(lod.kind_of_function('31001_3041', 300), lod.KIND_RELIGIOUS)
        self.assertEqual(lod.kind_of_function('51009_1610', 30), lod.KIND_ROOF)
        self.assertIsNone(lod.kind_of_function('53001_1800', 30))

    def test_ids_are_stable_and_clear_of_osm(self):
        self.assertEqual(lod.lod2_osm_id('DEBY_LOD2_75192'), (1 << 52) + 75192)
        self.assertGreater(lod.lod2_osm_id('weird'), 1 << 52)
        self.assertLess(lod.lod2_osm_id('weird'), 1 << 53)

    def test_alphanumeric_ids_are_hashed_not_cut_to_a_trailing_digit(self):
        a, b = lod.lod2_osm_id('DEBBAL010009e6j7'), lod.lod2_osm_id('DEBBAL540001v9m7')
        self.assertNotEqual(a, b)
        self.assertEqual(a, lod.lod2_osm_id('DEBBAL010009e6j7'))
        self.assertGreaterEqual(a, (1 << 52) + (1 << 40))
        self.assertLess(a, 1 << 53)


class Sources(unittest.TestCase):
    def test_potsdam_leaf_asks_brandenburg_and_berlin_in_utm33_kilometres(self):
        names = [s.name for s in lod.SOURCES if s.covers(*lod.tile_bounds(12, 4393, 855))]
        self.assertEqual(names, ['brandenburg', 'berlin'])
        tiles = lod.SOURCES[1].tiles_for(4393, 855)
        self.assertTrue(all(360 < e < 390 and 5790 < n < 5830 for e, n in tiles), tiles)

    def test_bavaria_tiles_stay_on_even_kilometres(self):
        tiles = lod.SOURCES[0].tiles_for(4348, 967)
        self.assertTrue(tiles and all(e % 2 == 0 and n % 2 == 0 for e, n in tiles))


class RidgeDirection(unittest.TestCase):
    def test_skillion_axis_turns_uphill(self):
        # One plane rising toward north (+y): uphill compass 0. The runtime's
        # axis is the one whose quarter turn counter-clockwise points uphill: east (90).
        plane = np.array([(0, 0, 700), (10, 0, 700), (10, 8, 703), (0, 8, 703)], float)
        az = lod.ridge_azimuth([plane], lod.SKILLION)
        self.assertAlmostEqual(az, 90.0, delta=0.5)

    def test_flat_pieces_say_nothing(self):
        flat = np.array([(0, 0, 700), (10, 0, 700), (10, 8, 700), (0, 8, 700)], float)
        self.assertIsNone(lod.ridge_azimuth([flat], lod.GABLED))


def osm(osm_id, lon, lat, dlon=0.00016, dlat=0.00011):
    return Building(osm_id, 0, 0, 0, math.nan, math.nan, math.nan, math.nan, math.nan, math.nan, -1, -1,
                    [[(lon, lat), (lon + dlon, lat), (lon + dlon, lat + dlat), (lon, lat + dlat)]])


class Match(unittest.TestCase):
    def setUp(self):
        # An OSM outline of ~12 x 12 m at Garmisch, and its UTM box.
        self.b = osm(7, 11.09, 47.49)
        xs, ys = lod.to_utm([11.09, 11.09016], [47.49, 47.49011])
        self.x0, self.y0, self.x1, self.y1 = xs.min(), ys.min(), xs.max(), ys.max()

    def lod2_in(self, fx0, fy0, fx1, fy1, form=lod.GABLED):
        from shapely.geometry import box
        p = box(self.x0 + fx0 * (self.x1 - self.x0), self.y0 + fy0 * (self.y1 - self.y0),
                self.x0 + fx1 * (self.x1 - self.x0), self.y0 + fy1 * (self.y1 - self.y0))
        return {'id': f'{fx0}{fy0}', 'adv': 3100, 'form': form, 'area': p.area, 'point': p.representative_point(),
                'poly': p, 'function': '31001_1000', 'eave': 5.0, 'ridge': 9.0, 'azimuth': 90.0}

    def test_one(self):
        got, counts, _missing = lod.match([self.b], [self.lod2_in(0.02, 0.02, 0.98, 0.98)])
        self.assertEqual(got[7][2], lod.MATCH_ONE)
        self.assertEqual(got[7][1], lod.GABLED)
        self.assertEqual((got[7][5], got[7][6]), (500, 900))
        self.assertEqual(counts['one'], 1)

    def test_merged_terrace(self):
        parts = [self.lod2_in(0.0, 0.0, 0.5, 1.0), self.lod2_in(0.5, 0.0, 1.0, 1.0, form=lod.HIPPED)]
        got, counts, _missing = lod.match([self.b], parts)
        self.assertEqual(got[7][2], lod.MATCH_MERGED)
        self.assertEqual(got[7][7], 2)

    def test_a_shed_on_a_big_outline_is_partial(self):
        got, counts, _missing = lod.match([self.b], [self.lod2_in(0.1, 0.1, 0.35, 0.35)])
        self.assertEqual(got[7][2], lod.MATCH_PARTIAL)

    def test_lod2_outside_every_outline(self):
        far = self.lod2_in(3.0, 3.0, 3.5, 3.5)
        got, counts, missing = lod.match([self.b], [far])
        self.assertEqual(got, {})
        self.assertEqual(counts['lod2Unmatched'], 1)
        self.assertEqual(missing, [far])

    def test_a_neighbour_leaf_outline_claims_it(self):
        far = self.lod2_in(3.0, 3.0, 3.5, 3.5)
        xs, ys = lod.to_utm([11.09], [47.49])
        # The OSM outline that covers `far` belongs to the next leaf.
        from rasterio.warp import transform
        cx, cy = far['point'].x, far['point'].y
        lons, lats = transform('EPSG:25832', 'EPSG:4326', [cx - 10, cx + 10, cx + 10, cx - 10], [cy - 10, cy - 10, cy + 10, cy + 10])
        nb = Building(8, 0, 0, 0, math.nan, math.nan, math.nan, math.nan, math.nan, math.nan, -1, -1,
                      [list(zip(lons, lats))])
        got, counts, missing = lod.match([self.b], [far], neighbours=[nb])
        self.assertEqual(missing, [])
        self.assertNotIn(8, got, 'a neighbour gets no record here')

    def test_one_that_mostly_overlaps_an_outline_is_not_missing(self):
        # Its point just outside the outline, most of it inside.
        straddle = self.lod2_in(0.3, -0.15, 1.0, 0.6)
        straddle['point'] = __import__('shapely.geometry', fromlist=['Point']).Point(
            self.x0 + 0.5 * (self.x1 - self.x0), self.y0 - 0.1 * (self.y1 - self.y0))
        _got, _counts, missing = lod.match([self.b], [straddle])
        self.assertEqual(missing, [])


class Store(unittest.TestCase):
    def test_round_trip(self):
        recs = [(7, lod.GABLED, lod.MATCH_ONE, 3100, 9000, 500, 900, 1), (-2, 0, lod.MATCH_PARTIAL, 5000, lod.NO_AZIMUTH, 0, 400, 3)]
        sig, got = lod.decode_bls(lod.encode_bls(99, recs))
        self.assertEqual(sig, 99)
        self.assertEqual(got, sorted(recs))


if __name__ == '__main__':
    unittest.main()
