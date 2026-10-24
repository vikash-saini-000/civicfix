// Simulated city data for the Surathkal–Mangaluru coast (demo only). Locality names are real; ward
// boundaries, places and coordinates are approximate and invented for the demo, not official data.
import type { Category, PlaceKind } from '../../models/enums.js';

/** Rectangle → closed GeoJSON ring. */
const rect = (south: number, west: number, north: number, east: number) => [
  [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ],
];

export interface WardSeed {
  code: string;
  name: string;
  population: number;
  bounds: [number, number, number, number]; // south, west, north, east
}

// Two columns (coast / inland) × four bands, north to south.
export const WARDS: WardSeed[] = [
  { code: 'W01', name: 'Surathkal', population: 42_000, bounds: [13.0, 74.77, 13.04, 74.82] },
  { code: 'W02', name: 'Katipalla', population: 36_000, bounds: [13.0, 74.82, 13.04, 74.88] },
  { code: 'W03', name: 'Kulai', population: 28_000, bounds: [12.96, 74.77, 13.0, 74.82] },
  { code: 'W04', name: 'Bajpe Road', population: 22_000, bounds: [12.96, 74.82, 13.0, 74.88] },
  { code: 'W05', name: 'Panambur', population: 31_000, bounds: [12.92, 74.77, 12.96, 74.82] },
  { code: 'W06', name: 'Kavoor', population: 34_000, bounds: [12.92, 74.82, 12.96, 74.88] },
  { code: 'W07', name: 'Bengre', population: 19_000, bounds: [12.88, 74.77, 12.92, 74.82] },
  { code: 'W08', name: 'Kottara', population: 38_000, bounds: [12.88, 74.82, 12.92, 74.88] },
];
export const wardPolygon = (w: WardSeed) => ({ type: 'Polygon' as const, coordinates: rect(...w.bounds) });
export const NORTH_WARDS = ['W01', 'W02', 'W03', 'W04'];
export const SOUTH_WARDS = ['W05', 'W06', 'W07', 'W08'];

export interface PlaceSeed {
  name: string;
  kind: PlaceKind;
  point?: [number, number]; // [lat, lng]
  line?: [number, number][]; // [[lat, lng], ...]
}

export const PLACES: PlaceSeed[] = [
  // Main roads (lines)
  { name: 'NH-66 (Mangaluru–Udupi highway)', kind: 'MAIN_ROAD', line: [[13.039, 74.7985], [13.012, 74.7992], [12.99, 74.8013], [12.965, 74.8041], [12.94, 74.8072], [12.915, 74.8115], [12.885, 74.8158]] },
  { name: 'MRPL Road', kind: 'MAIN_ROAD', line: [[13.0115, 74.7995], [13.0128, 74.825], [13.0141, 74.852], [13.0152, 74.875]] },
  { name: 'Panambur Beach Road', kind: 'MAIN_ROAD', line: [[12.9415, 74.8071], [12.9418, 74.7975], [12.9421, 74.7905]] },
  { name: 'Kavoor–Bajpe Road', kind: 'MAIN_ROAD', line: [[12.9285, 74.835], [12.945, 74.8505], [12.962, 74.8645], [12.985, 74.8725]] },
  { name: 'Kottara Chowki Road', kind: 'MAIN_ROAD', line: [[12.8965, 74.8195], [12.8995, 74.835], [12.9022, 74.851]] },
  // Schools
  { name: 'Govt. Higher Primary School, Surathkal', kind: 'SCHOOL', point: [13.0086, 74.7966] },
  { name: 'Vidyadayinee High School, Surathkal', kind: 'SCHOOL', point: [13.0029, 74.7942] },
  { name: 'Kulai Govt. High School', kind: 'SCHOOL', point: [12.9791, 74.8049] },
  { name: 'Katipalla Govt. Primary School', kind: 'SCHOOL', point: [13.0175, 74.8455] },
  { name: 'Panambur Public School', kind: 'SCHOOL', point: [12.9452, 74.8091] },
  { name: 'Kavoor Govt. Primary School', kind: 'SCHOOL', point: [12.9318, 74.8552] },
  { name: 'Bengre Govt. School', kind: 'SCHOOL', point: [12.8981, 74.7932] },
  { name: 'Kottara Chowki English School', kind: 'SCHOOL', point: [12.8979, 74.8402] },
  // Hospitals
  { name: 'Surathkal Community Health Centre', kind: 'HOSPITAL', point: [13.0058, 74.7991] },
  { name: 'Kulai Primary Health Centre', kind: 'HOSPITAL', point: [12.9832, 74.8071] },
  { name: 'Kavoor Nursing Home', kind: 'HOSPITAL', point: [12.9281, 74.8619] },
  { name: 'Kottara Maternity Hospital', kind: 'HOSPITAL', point: [12.8941, 74.8455] },
  // Markets, bus stops, places of worship
  { name: 'Surathkal Fish Market', kind: 'MARKET', point: [13.0049, 74.7946] },
  { name: 'Katipalla Market', kind: 'MARKET', point: [13.0162, 74.8521] },
  { name: 'Kavoor Market', kind: 'MARKET', point: [12.9302, 74.8591] },
  { name: 'Surathkal Bus Stand', kind: 'BUS_STOP', point: [13.0071, 74.7961] },
  { name: 'Kulai Junction Bus Stop', kind: 'BUS_STOP', point: [12.9802, 74.8029] },
  { name: 'Panambur Bus Stop', kind: 'BUS_STOP', point: [12.9431, 74.8075] },
  { name: 'Kottara Chowki Bus Stop', kind: 'BUS_STOP', point: [12.8992, 74.8301] },
  { name: 'Sadashiva Temple, Surathkal', kind: 'PLACE_OF_WORSHIP', point: [13.0124, 74.7931] },
  { name: 'Kavoor Mahalingeshwara Temple', kind: 'PLACE_OF_WORSHIP', point: [12.9339, 74.8577] },
];

export interface DepartmentSeed {
  key: string;
  name: string;
  description: string;
  categories: Category[];
  /** Ward codes served; empty = whole city. */
  wards: string[];
  workers: number;
  offDutyWorkers?: number;
}

export const DEPARTMENTS: DepartmentSeed[] = [
  { key: 'roads', name: 'Roads and Public Works', description: 'Potholes, road surface, footpaths and road signs in the northern wards.', categories: ['roads'], wards: NORTH_WARDS, workers: 3, offDutyWorkers: 1 },
  { key: 'roads-south', name: 'Roads – South Zone', description: 'Potholes, road surface, footpaths and road signs in the southern wards.', categories: ['roads'], wards: SOUTH_WARDS, workers: 2 },
  { key: 'sanitation', name: 'Sanitation', description: 'Garbage collection, overflowing bins and illegal dumping.', categories: ['garbage'], wards: [], workers: 3 },
  { key: 'electrical', name: 'Street Lighting', description: 'Broken or flickering streetlights and exposed wiring.', categories: ['streetlight'], wards: [], workers: 2 },
  { key: 'water', name: 'Water Supply', description: 'Leaks, burst pipes, no supply and water quality.', categories: ['water'], wards: [], workers: 2 },
  { key: 'drainage', name: 'Drainage', description: 'Blocked drains, flooding and open manholes.', categories: ['drainage'], wards: [], workers: 2, offDutyWorkers: 1 },
  { key: 'general', name: 'General Administration', description: 'Issues that fit no other department.', categories: ['other'], wards: [], workers: 2 },
];
