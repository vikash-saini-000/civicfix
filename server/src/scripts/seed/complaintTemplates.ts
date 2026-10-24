// Demo complaint texts. Written to read like real reports (mixed English, Hindi, Kannada), with the
// English one-line summary the triage model would produce. Simulated data for demos only.
import type { Category, Priority } from '../../models/enums.js';

export interface Template {
  title: string;
  description: string;
  summary: string;
  priority: Priority;
}

export const TEMPLATES: Record<Exclude<Category, 'other'>, Template[]> = {
  roads: [
    { title: 'Deep pothole on the highway service road', description: 'There is a deep pothole on the service road near {place}. Two-wheelers swerve into traffic to avoid it, especially at night.', summary: 'Deep pothole on the service road near {place} forcing two-wheelers into traffic.', priority: 'P2' },
    { title: 'Road surface broken after rain', description: 'After the heavy rain the road near {place} has broken up badly. Loose gravel everywhere and water stands in the holes.', summary: 'Road surface near {place} broken up after rain, with loose gravel and water-filled holes.', priority: 'P3' },
    { title: 'Big potholes, bikes falling', description: 'Many big potholes near {place}. Yesterday a scooter fell. Please repair before someone is badly hurt.', summary: 'Several large potholes near {place}; a scooter rider fell yesterday.', priority: 'P2' },
    { title: 'गड्ढों से भरी सड़क', description: '{place} के पास सड़क पर बहुत बड़े गड्ढे हैं। बारिश में पानी भर जाता है और गड्ढे दिखाई नहीं देते।', summary: 'Large potholes near {place} fill with rainwater and become invisible to drivers.', priority: 'P2' },
    { title: 'ರಸ್ತೆಯಲ್ಲಿ ದೊಡ್ಡ ಹೊಂಡ', description: '{place} ಹತ್ತಿರ ರಸ್ತೆಯಲ್ಲಿ ದೊಡ್ಡ ಹೊಂಡ ಇದೆ. ರಾತ್ರಿ ವಾಹನ ಸವಾರರಿಗೆ ತುಂಬಾ ಅಪಾಯ.', summary: 'Large pothole near {place}, dangerous for riders at night.', priority: 'P2' },
    { title: 'Footpath slabs broken', description: 'Footpath slabs near {place} are broken and some are missing. Elderly people and children have to walk on the road.', summary: 'Broken and missing footpath slabs near {place} force pedestrians onto the road.', priority: 'P3' },
    { title: 'Speed breaker paint gone', description: 'The speed breaker near {place} has no paint or sign. Vehicles hit it fast and jump.', summary: 'Unmarked speed breaker near {place}; vehicles hit it at speed.', priority: 'P4' },
    { title: 'Road edge eroded', description: 'The road edge near {place} has eroded and there is a sharp drop of about a foot. Buses are using that side.', summary: 'Eroded road edge near {place} with a sharp drop on a bus route.', priority: 'P3' },
  ],
  garbage: [
    { title: 'Garbage not collected for days', description: 'Garbage near {place} has not been collected for four days. Dogs are spreading it on the road and it smells very bad.', summary: 'Garbage near {place} uncollected for four days, scattered by dogs.', priority: 'P3' },
    { title: 'Overflowing community bin', description: 'The community bin near {place} is overflowing onto the road. Plastic and food waste everywhere.', summary: 'Community bin near {place} overflowing onto the road.', priority: 'P3' },
    { title: 'Illegal dumping of construction waste', description: 'Someone dumped construction debris and waste near {place} overnight. It is blocking half the lane.', summary: 'Construction debris dumped near {place}, blocking half the lane.', priority: 'P3' },
    { title: 'कचरा नहीं उठाया गया', description: '{place} के पास तीन दिन से कचरा नहीं उठाया गया है। बहुत बदबू आ रही है और मच्छर हो गए हैं।', summary: 'Garbage near {place} uncollected for three days; strong smell and mosquitoes.', priority: 'P3' },
    { title: 'ಕಸ ವಿಲೇವಾರಿ ಆಗಿಲ್ಲ', description: '{place} ಹತ್ತಿರ ಕಸ ಒಂದು ವಾರದಿಂದ ತೆಗೆದಿಲ್ಲ. ನಾಯಿಗಳು ಹರಡುತ್ತಿವೆ.', summary: 'Garbage near {place} not cleared for a week and being scattered by dogs.', priority: 'P3' },
    { title: 'Fish waste dumped in open', description: 'Fish waste is being dumped in the open near {place}. Very strong smell, crows and dogs all over.', summary: 'Fish waste dumped in the open near {place}, attracting animals.', priority: 'P2' },
  ],
  streetlight: [
    { title: 'Streetlight not working', description: 'The streetlight near {place} has not worked for a week. The stretch is completely dark at night.', summary: 'Streetlight near {place} out for a week; stretch dark at night.', priority: 'P3' },
    { title: 'Several streetlights off', description: 'Four or five streetlights in a row near {place} are off. Women walking home feel unsafe.', summary: 'A row of streetlights near {place} is off, making the area unsafe at night.', priority: 'P2' },
    { title: 'Streetlight flickering', description: 'Streetlight near {place} keeps flickering on and off all night.', summary: 'Flickering streetlight near {place}.', priority: 'P4' },
    { title: 'ಬೀದಿ ದೀಪ ಉರಿಯುತ್ತಿಲ್ಲ', description: '{place} ಹತ್ತಿರ ಬೀದಿ ದೀಪ ಹತ್ತು ದಿನಗಳಿಂದ ಉರಿಯುತ್ತಿಲ್ಲ.', summary: 'Streetlight near {place} not working for ten days.', priority: 'P3' },
    { title: 'Light on during the day', description: 'The streetlights near {place} stay on the whole day, wasting electricity.', summary: 'Streetlights near {place} stay on during the day.', priority: 'P4' },
  ],
  water: [
    { title: 'Pipe leaking on the road', description: 'Drinking water pipe is leaking near {place}. Water has been flowing onto the road since morning.', summary: 'Drinking water pipe leaking onto the road near {place} since morning.', priority: 'P2' },
    { title: 'No water supply for two days', description: 'Houses near {place} have had no water supply for two days. No notice was given.', summary: 'No water supply for two days for houses near {place}.', priority: 'P2' },
    { title: 'Dirty water in taps', description: 'Water coming in the taps near {place} is brown and smells. Children are falling sick.', summary: 'Brown, smelly tap water near {place}; residents report illness.', priority: 'P2' },
    { title: 'पानी की पाइप फटी', description: '{place} के पास पानी की पाइप फट गई है, सड़क पर पानी बह रहा है।', summary: 'Burst water pipe near {place} flooding the road.', priority: 'P2' },
    { title: 'Low water pressure', description: 'Water pressure near {place} is very low for the last week. Upper floors get nothing.', summary: 'Very low water pressure near {place} for a week.', priority: 'P3' },
  ],
  drainage: [
    { title: 'Drain blocked, road flooded', description: 'The roadside drain near {place} is blocked with plastic and silt. After rain the road floods and water enters shops.', summary: 'Blocked drain near {place} floods the road and shops after rain.', priority: 'P2' },
    { title: 'Drain overflowing with sewage', description: 'Drain near {place} is overflowing with sewage. Unbearable smell and mosquitoes.', summary: 'Sewage overflowing from the drain near {place}.', priority: 'P2' },
    { title: 'Broken drain cover', description: 'A drain cover near {place} is broken and the opening is on the footpath. Someone can fall in.', summary: 'Broken drain cover leaves an opening on the footpath near {place}.', priority: 'P2' },
    { title: 'ಚರಂಡಿ ಕಟ್ಟಿಕೊಂಡಿದೆ', description: '{place} ಹತ್ತಿರ ಚರಂಡಿ ಕಟ್ಟಿಕೊಂಡಿದೆ. ಮಳೆ ಬಂದಾಗ ನೀರು ರಸ್ತೆಗೆ ಬರುತ್ತದೆ.', summary: 'Blocked drain near {place} overflows onto the road when it rains.', priority: 'P3' },
    { title: 'Stagnant water in drain', description: 'Water has been stagnant in the open drain near {place} for weeks. Mosquito breeding.', summary: 'Stagnant water in the open drain near {place} breeding mosquitoes.', priority: 'P3' },
  ],
};

export const OTHER_TEMPLATES: Template[] = [
  { title: 'Fallen tree branch on footpath', description: 'A big tree branch has fallen on the footpath near {place}. People are walking on the road.', summary: 'Fallen tree branch blocking the footpath near {place}.', priority: 'P3' },
  { title: 'Stray cattle on the road', description: 'Cattle sit in the middle of the road near {place} every evening and cause accidents.', summary: 'Stray cattle on the road near {place} in the evenings.', priority: 'P3' },
  { title: 'Bus shelter roof damaged', description: 'The roof of the bus shelter near {place} is broken. No shelter from rain.', summary: 'Damaged bus shelter roof near {place}.', priority: 'P4' },
];

export const PLACE_HINTS = [
  'the bus stop',
  'the junction',
  'the temple gate',
  'the school gate',
  'the market',
  'the petrol pump',
  'the bank',
  'the hospital entrance',
  'the bakery',
  'the post office',
];

/** Cases waiting for a human routing decision, with the reasons the rules would record. */
export const REVIEW_CASES: {
  category: Category;
  citizenCategory?: Category;
  title: string;
  description: string;
  summary: string;
  priority: Priority;
  certainty: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
  hazard?: boolean;
  spam?: { score: number; signals: string[] };
  followUp?: string[];
  reasons: string[];
  near: [number, number];
}[] = [
  { category: 'streetlight', title: 'Live wire hanging near school gate', description: 'A streetlight cable has snapped and is hanging at head height near the school gate. Sparks were seen this morning. Children walk here.', summary: 'Snapped streetlight cable hanging at head height near a school gate; sparks seen.', priority: 'P1', certainty: 'HIGH', confidence: 0.94, hazard: true, reasons: ['HIGH_URGENCY', 'PUBLIC_SAFETY_HAZARD'], near: [13.0084, 74.7963] },
  { category: 'drainage', title: 'Open manhole on main road', description: 'The manhole cover is missing on the main road near the junction. It is full of water and you cannot see it. A bike almost fell in.', summary: 'Missing manhole cover on a main road near the junction, hidden by water.', priority: 'P1', certainty: 'HIGH', confidence: 0.91, hazard: true, reasons: ['HIGH_URGENCY', 'PUBLIC_SAFETY_HAZARD'], near: [12.9806, 74.8036] },
  { category: 'water', title: 'Water problem', description: 'There is a water problem in our area for many days. Please do something.', summary: 'Unspecified water problem in the area for several days.', priority: 'P3', certainty: 'LOW', confidence: 0.42, followUp: ['Is the problem no water, low pressure, dirty water, or a leaking pipe?', 'Which street or landmark is closest to the problem?'], reasons: ['LOW_CONFIDENCE', 'AWAITING_CITIZEN_INFO'], near: [12.9654, 74.8551] },
  { category: 'other', title: 'ಸಮಸ್ಯೆ ಇದೆ', description: 'ನಮ್ಮ ಬೀದಿಯಲ್ಲಿ ತುಂಬಾ ಸಮಸ್ಯೆ ಇದೆ. ದಯವಿಟ್ಟು ಬನ್ನಿ.', summary: 'Unspecified problem on the reporter’s street.', priority: 'P4', certainty: 'LOW', confidence: 0.3, followUp: ['ಸಮಸ್ಯೆ ಏನು? (ರಸ್ತೆ, ಕಸ, ಬೀದಿ ದೀಪ, ನೀರು ಅಥವಾ ಚರಂಡಿ)', 'ಹತ್ತಿರದ ಗುರುತು ಯಾವುದು?'], reasons: ['LOW_CONFIDENCE', 'UNCLEAR_DEPARTMENT', 'AWAITING_CITIZEN_INFO'], near: [12.9087, 74.8577] },
  { category: 'other', title: 'Best home loans offer!!!', description: 'Get instant home loans at lowest rates. Call now 9876543210 or visit www.fast-loans-offer.xyz for discount.', summary: 'Advertisement for loans; not a civic problem.', priority: 'P4', certainty: 'HIGH', confidence: 0.9, spam: { score: 0.88, signals: ['contains_link', 'contains_phone_number', 'promotional_language'] }, reasons: ['SPAM_SUSPECTED', 'UNCLEAR_DEPARTMENT'], near: [13.0201, 74.8251] },
  { category: 'other', title: 'asdfgh test test', description: 'asdfghjkl qwerty test test test test test test test', summary: 'Test or gibberish text; no problem described.', priority: 'P4', certainty: 'HIGH', confidence: 0.88, spam: { score: 0.6, signals: ['gibberish'] }, reasons: ['SPAM_SUSPECTED', 'UNCLEAR_DEPARTMENT'], near: [12.9501, 74.7891] },
  { category: 'drainage', citizenCategory: 'water', title: 'Water flooding the street', description: 'Every time it rains water floods our street because the drain at the corner is blocked with mud.', summary: 'Street floods during rain because the corner drain is blocked with mud.', priority: 'P3', certainty: 'HIGH', confidence: 0.86, reasons: ['CATEGORY_CONFLICT'], near: [12.9012, 74.8399] },
  { category: 'roads', title: 'Pothole near Kulai junction again', description: 'The pothole near Kulai junction bus stop is back. Same place as last month.', summary: 'Pothole reappeared near the Kulai junction bus stop.', priority: 'P2', certainty: 'HIGH', confidence: 0.9, reasons: ['AMBIGUOUS_DUPLICATE'], near: [12.9805, 74.8032] },
  { category: 'other', title: 'Loud music every night', description: 'Neighbours play loud music every night till 1 am. Cannot sleep.', summary: 'Nightly loud music from neighbours; not a municipal works issue.', priority: 'P4', certainty: 'MEDIUM', confidence: 0.55, reasons: ['LOW_CONFIDENCE', 'UNCLEAR_DEPARTMENT'], near: [12.9385, 74.8402] },
];
