// Labelled synthetic test set for the CivicFix vs keyword-baseline evaluation (npm run eval).
// 120 independent reports + 30 planted duplicates (20 %), in English, Hindi and Kannada, including
// hazards, spam and reports that are not civic problems. Labels are what a careful municipal officer
// would decide. Written for this evaluation; not real citizen data.
import type { Category } from '../../src/models/enums.js';

export type Lang = 'en' | 'hi' | 'kn';

export interface EvalCase {
  id: string;
  title: string;
  description: string;
  lang: Lang;
  expected: {
    category: Category;
    /** Possible injury soon: must go to a human. */
    hazard: boolean;
    /** Advertising, abuse, gibberish or test text. */
    spam: boolean;
  };
  /** Set on planted duplicates: id of the earlier report of the same problem at the same spot. */
  duplicateOf?: string;
}

type Row = [Category, Lang, string, string, ('hazard' | 'spam')?];

// ---- 120 independent reports ----
const BASE: Row[] = [
  // roads (24)
  ['roads', 'en', 'Deep pothole near bus stop', 'There is a deep pothole on the service road near the bus stop. Two-wheelers swerve into traffic to avoid it.'],
  ['roads', 'en', 'Road broken after rain', 'After last week’s rain the road surface has broken up near the school junction. Loose stones everywhere.'],
  ['roads', 'en', 'Footpath slabs missing', 'Several footpath slabs are missing near the bank. Old people have to walk on the road.'],
  ['roads', 'en', 'Speed breaker without paint', 'The new speed breaker near the petrol pump has no paint and no sign board. Bikes jump on it at night.'],
  ['roads', 'en', 'Road edge collapsed', 'The edge of the road near the temple has collapsed into the ditch, about a foot deep drop. Buses use that side.'],
  ['roads', 'en', 'Big crater on highway', 'A huge crater has formed in the middle lane of the highway near the flyover. Cars brake suddenly.', 'hazard'],
  ['roads', 'en', 'Uneven road patch', 'The road was patched last month near the post office but the patch is higher than the road and cars scrape it.'],
  ['roads', 'en', 'Road dug up and left open', 'Someone dug up the road for cable work near the bakery and left it open for two weeks.'],
  ['roads', 'en', 'Potholes on internal road', 'Our internal colony road has many small potholes. It is very bumpy for autos.'],
  ['roads', 'en', 'Manhole cover sunk below road', 'A manhole cover on the main road has sunk about four inches below the road level, cars hit it hard.'],
  ['roads', 'en', 'Road signs fallen', 'The direction sign board at the junction has fallen down and is lying on the footpath.'],
  ['roads', 'en', 'Gravel spread on bend', 'Gravel from a truck is spread all over the bend near the hospital. Two bikes skidded today.', 'hazard'],
  ['roads', 'hi', 'सड़क पर गड्ढे', 'बस स्टॉप के पास सड़क पर बहुत बड़े गड्ढे हैं। बारिश में पानी भर जाता है और गड्ढे दिखाई नहीं देते।'],
  ['roads', 'hi', 'टूटी हुई सड़क', 'स्कूल के सामने की सड़क पूरी तरह टूट गई है। बच्चों को चलने में परेशानी होती है।'],
  ['roads', 'hi', 'फुटपाथ टूटा', 'बाजार के पास फुटपाथ टूटा हुआ है, लोग सड़क पर चल रहे हैं।'],
  ['roads', 'hi', 'सड़क धंस गई', 'मंदिर के पास सड़क का एक हिस्सा धंस गया है। रात में बहुत खतरनाक है।', 'hazard'],
  ['roads', 'kn', 'ರಸ್ತೆಯಲ್ಲಿ ಹೊಂಡ', 'ಬಸ್ ನಿಲ್ದಾಣದ ಹತ್ತಿರ ರಸ್ತೆಯಲ್ಲಿ ದೊಡ್ಡ ಹೊಂಡ ಇದೆ. ರಾತ್ರಿ ವಾಹನ ಸವಾರರಿಗೆ ಅಪಾಯ.'],
  ['roads', 'kn', 'ರಸ್ತೆ ಹಾಳಾಗಿದೆ', 'ಶಾಲೆಯ ಮುಂದೆ ರಸ್ತೆ ಸಂಪೂರ್ಣ ಹಾಳಾಗಿದೆ. ಮಳೆಗಾಲದಲ್ಲಿ ಕೆಸರು ತುಂಬಿರುತ್ತದೆ.'],
  ['roads', 'kn', 'ಫುಟ್‌ಪಾತ್ ಹಾಳು', 'ಮಾರುಕಟ್ಟೆ ಹತ್ತಿರ ಫುಟ್‌ಪಾತ್ ಕಲ್ಲುಗಳು ಮುರಿದಿವೆ.'],
  ['roads', 'en', 'Pothole filled with water', 'Pothole near the church is always filled with water, you cannot see how deep it is.'],
  ['roads', 'en', 'Road narrowed by debris', 'Construction debris has been dumped on the road edge, narrowing the road to one lane near the mosque.'],
  ['roads', 'en', 'Cracks across the bridge road', 'There are long cracks across the road on the small bridge over the canal.'],
  ['roads', 'en', 'Zebra crossing faded', 'The zebra crossing in front of the school has completely faded. Children cross without any marking.'],
  ['roads', 'en', 'Road dust from broken tar', 'The tar has come off the whole stretch near the market and it is all dust now.'],
  // garbage (20)
  ['garbage', 'en', 'Garbage not collected', 'Garbage near the market has not been collected for four days. Dogs are spreading it on the road.'],
  ['garbage', 'en', 'Overflowing bin', 'The community bin near the bus stop is overflowing onto the road. Very bad smell.'],
  ['garbage', 'en', 'Construction waste dumped', 'Someone dumped construction waste and plastic near the lake overnight.'],
  ['garbage', 'en', 'Burning garbage', 'People are burning garbage in the open plot behind the school every evening. Smoke enters classrooms.'],
  ['garbage', 'en', 'Dead dog on road', 'A dead dog has been lying on the road near the bakery since yesterday. Nobody has removed it.'],
  ['garbage', 'en', 'Fish waste in open', 'Fish waste is dumped in the open near the fish market. Crows and dogs everywhere.'],
  ['garbage', 'en', 'Garbage truck skipped our street', 'The garbage truck has not come to our street for a week.'],
  ['garbage', 'en', 'Plastic in the beach', 'Lots of plastic waste has piled up at the beach entrance after the festival.'],
  ['garbage', 'en', 'Medical waste in bin', 'Used syringes and medical waste are thrown in the public bin near the clinic.', 'hazard'],
  ['garbage', 'en', 'Garbage blocking footpath', 'Garbage bags are left on the footpath near the ATM and block the way.'],
  ['garbage', 'hi', 'कचरा नहीं उठाया', 'बाजार के पास तीन दिन से कचरा नहीं उठाया गया है। बहुत बदबू आ रही है।'],
  ['garbage', 'hi', 'कूड़ेदान भरा हुआ', 'बस स्टॉप के पास कूड़ेदान पूरा भर गया है और कचरा सड़क पर गिर रहा है।'],
  ['garbage', 'hi', 'खुले में कचरा जलाना', 'हमारे मोहल्ले में लोग रोज़ खुले में कचरा जलाते हैं।'],
  ['garbage', 'kn', 'ಕಸ ತೆಗೆದಿಲ್ಲ', 'ಮಾರುಕಟ್ಟೆ ಹತ್ತಿರ ಕಸ ಒಂದು ವಾರದಿಂದ ತೆಗೆದಿಲ್ಲ. ನಾಯಿಗಳು ಹರಡುತ್ತಿವೆ.'],
  ['garbage', 'kn', 'ಕಸದ ಡಬ್ಬಿ ತುಂಬಿದೆ', 'ಬಸ್ ನಿಲ್ದಾಣದ ಕಸದ ಡಬ್ಬಿ ತುಂಬಿ ಹೊರಗೆ ಚೆಲ್ಲುತ್ತಿದೆ.'],
  ['garbage', 'kn', 'ಕಸ ಸುಡುತ್ತಿದ್ದಾರೆ', 'ಖಾಲಿ ಜಾಗದಲ್ಲಿ ಪ್ರತಿದಿನ ಕಸ ಸುಡುತ್ತಾರೆ, ಹೊಗೆ ಮನೆಗೆ ಬರುತ್ತದೆ.'],
  ['garbage', 'en', 'Waste behind hotel', 'The hotel behind the junction throws food waste in the lane every night.'],
  ['garbage', 'en', 'Coconut shells pile', 'Huge pile of coconut shells and leaves left on the roadside after tree trimming.'],
  ['garbage', 'en', 'E-waste dumped', 'Old TVs and computer parts dumped next to the bus shelter.'],
  ['garbage', 'en', 'Bins without lids', 'All the bins on our road have no lids and monkeys spread the waste.'],
  // streetlight (18)
  ['streetlight', 'en', 'Streetlight not working', 'The streetlight near the bus stop has not worked for a week. It is completely dark at night.'],
  ['streetlight', 'en', 'Row of lights off', 'Five streetlights in a row on the school road are off. Women feel unsafe walking home.'],
  ['streetlight', 'en', 'Flickering light', 'The streetlight outside the temple keeps flickering all night.'],
  ['streetlight', 'en', 'Lights on in daytime', 'Streetlights on our road stay on during the day, wasting electricity.'],
  ['streetlight', 'en', 'Live wire hanging', 'A streetlight cable has snapped and is hanging at head height over the footpath outside the school. Sparks seen this morning.', 'hazard'],
  ['streetlight', 'en', 'Pole leaning dangerously', 'The streetlight pole near the market is leaning badly after the storm and may fall on the road.', 'hazard'],
  ['streetlight', 'en', 'Junction box open', 'The streetlight junction box at the corner is open with exposed wires at child height.', 'hazard'],
  ['streetlight', 'en', 'Light broken by truck', 'A truck hit the streetlight near the petrol pump and the lamp is broken.'],
  ['streetlight', 'en', 'Dim lights', 'The new LED streetlights near the park are very dim and do not light the road.'],
  ['streetlight', 'hi', 'स्ट्रीट लाइट बंद', 'बस स्टॉप के पास की स्ट्रीट लाइट एक हफ्ते से बंद है। रात में बहुत अंधेरा रहता है।'],
  ['streetlight', 'hi', 'बिजली का तार लटका', 'स्कूल के पास स्ट्रीट लाइट का तार नीचे लटक रहा है, बच्चों के लिए खतरा है।', 'hazard'],
  ['streetlight', 'hi', 'लाइट टिमटिमा रही', 'मंदिर के पास की लाइट पूरी रात टिमटिमाती रहती है।'],
  ['streetlight', 'kn', 'ಬೀದಿ ದೀಪ ಇಲ್ಲ', 'ಬಸ್ ನಿಲ್ದಾಣದ ಬಳಿ ಬೀದಿ ದೀಪ ಹತ್ತು ದಿನಗಳಿಂದ ಉರಿಯುತ್ತಿಲ್ಲ.'],
  ['streetlight', 'kn', 'ದೀಪದ ಕಂಬ ಬಾಗಿದೆ', 'ಮಾರುಕಟ್ಟೆ ಹತ್ತಿರ ಬೀದಿ ದೀಪದ ಕಂಬ ಬಾಗಿದೆ, ಬೀಳುವ ಸಾಧ್ಯತೆ ಇದೆ.', 'hazard'],
  ['streetlight', 'kn', 'ದೀಪ ಹಗಲು ಉರಿಯುತ್ತಿದೆ', 'ನಮ್ಮ ರಸ್ತೆಯ ಬೀದಿ ದೀಪಗಳು ಹಗಲಿನಲ್ಲೂ ಉರಿಯುತ್ತಿವೆ.'],
  ['streetlight', 'en', 'Lights off on highway stretch', 'Almost 1 km of the highway stretch near the college has no working streetlights.'],
  ['streetlight', 'en', 'Lamp missing', 'The lamp has been removed from the pole near the ATM and never replaced.'],
  ['streetlight', 'en', 'Timer wrong', 'Streetlights near the beach switch on only at 10 pm, it is dark from 7.'],
  // water (18)
  ['water', 'en', 'Pipe leaking on road', 'A drinking water pipe is leaking near the hospital. Water has been flowing onto the road since morning.'],
  ['water', 'en', 'No water supply', 'Houses on our street have had no water supply for two days. No notice was given.'],
  ['water', 'en', 'Dirty brown water', 'Water coming in the taps is brown and smells. Children are falling sick.'],
  ['water', 'en', 'Low pressure', 'Water pressure has been very low for a week. Upper floors get nothing.'],
  ['water', 'en', 'Burst main', 'A big water main has burst near the junction and water is gushing out, the road is flooding.', 'hazard'],
  ['water', 'en', 'Public tap broken', 'The public tap near the bus stop is broken and water runs all day.'],
  ['water', 'en', 'Water meter leaking', 'The municipal water meter in front of our house is leaking continuously.'],
  ['water', 'en', 'Supply only at midnight', 'Water comes only between 1 and 2 am in our area for the last month.'],
  ['water', 'en', 'Valve chamber open', 'The water valve chamber cover near the school is missing and the pit is open.', 'hazard'],
  ['water', 'hi', 'पानी की पाइप फटी', 'अस्पताल के पास पानी की पाइप फट गई है, सड़क पर पानी बह रहा है।'],
  ['water', 'hi', 'पानी नहीं आ रहा', 'हमारे इलाके में दो दिन से पानी नहीं आ रहा है।'],
  ['water', 'hi', 'गंदा पानी', 'नल में गंदा और बदबूदार पानी आ रहा है।'],
  ['water', 'kn', 'ನೀರಿನ ಪೈಪ್ ಒಡೆದಿದೆ', 'ಆಸ್ಪತ್ರೆ ಹತ್ತಿರ ಕುಡಿಯುವ ನೀರಿನ ಪೈಪ್ ಒಡೆದು ನೀರು ರಸ್ತೆಗೆ ಹರಿಯುತ್ತಿದೆ.'],
  ['water', 'kn', 'ನೀರು ಬರುತ್ತಿಲ್ಲ', 'ಎರಡು ದಿನಗಳಿಂದ ನಮ್ಮ ಬೀದಿಗೆ ನೀರು ಬರುತ್ತಿಲ್ಲ.'],
  ['water', 'kn', 'ಕೆಸರು ನೀರು', 'ನಲ್ಲಿಯಲ್ಲಿ ಕೆಸರು ಬಣ್ಣದ ನೀರು ಬರುತ್ತಿದೆ.'],
  ['water', 'en', 'Tanker not coming', 'The water tanker scheduled for our ward has not come for three days.'],
  ['water', 'en', 'Leak inside road', 'Water is bubbling up from a crack in the road, probably a pipe leak underneath.'],
  ['water', 'en', 'Overhead tank overflowing', 'The ward overhead water tank overflows every morning for an hour.'],
  // drainage (18)
  ['drainage', 'en', 'Drain blocked, road flooded', 'The roadside drain is blocked with plastic and silt. After rain the road floods and water enters shops.'],
  ['drainage', 'en', 'Sewage overflowing', 'The drain near the market is overflowing with sewage. Unbearable smell and mosquitoes.'],
  ['drainage', 'en', 'Open manhole', 'The manhole cover on the main road is missing and the hole is full of water. A bike almost fell in.', 'hazard'],
  ['drainage', 'en', 'Broken drain slab', 'A drain cover slab on the footpath is broken and someone can fall in.', 'hazard'],
  ['drainage', 'en', 'Stagnant drain water', 'Water has been stagnant in the open drain for weeks. Mosquitoes breeding.'],
  ['drainage', 'en', 'Sewage into homes', 'Sewage is backing up into the houses on our lane whenever it rains.', 'hazard'],
  ['drainage', 'en', 'Storm drain silted', 'The big storm drain near the college is fully silted before the monsoon.'],
  ['drainage', 'en', 'Drain smell', 'Very bad smell from the closed drain near the bus stand all day.'],
  ['drainage', 'en', 'Water logging at junction', 'The junction gets knee-deep water every time it rains because the drains are blocked.'],
  ['drainage', 'hi', 'नाली जाम', 'सड़क के किनारे की नाली प्लास्टिक से जाम है, बारिश में सड़क पर पानी भर जाता है।'],
  ['drainage', 'hi', 'गटर का पानी सड़क पर', 'गटर का गंदा पानी सड़क पर बह रहा है।'],
  ['drainage', 'hi', 'खुला मैनहोल', 'मुख्य सड़क पर मैनहोल का ढक्कन गायब है, बहुत खतरनाक है।', 'hazard'],
  ['drainage', 'kn', 'ಚರಂಡಿ ಕಟ್ಟಿಕೊಂಡಿದೆ', 'ರಸ್ತೆ ಬದಿಯ ಚರಂಡಿ ಕಟ್ಟಿಕೊಂಡಿದೆ. ಮಳೆ ಬಂದಾಗ ನೀರು ಅಂಗಡಿಗಳಿಗೆ ನುಗ್ಗುತ್ತದೆ.'],
  ['drainage', 'kn', 'ಒಳಚರಂಡಿ ಉಕ್ಕುತ್ತಿದೆ', 'ಮಾರುಕಟ್ಟೆ ಹತ್ತಿರ ಒಳಚರಂಡಿ ಉಕ್ಕಿ ಹರಿಯುತ್ತಿದೆ, ದುರ್ವಾಸನೆ.'],
  ['drainage', 'kn', 'ಚರಂಡಿ ಮುಚ್ಚಳ ಇಲ್ಲ', 'ಫುಟ್‌ಪಾತ್ ಮೇಲಿನ ಚರಂಡಿ ಮುಚ್ಚಳ ಒಡೆದಿದೆ, ಮಕ್ಕಳು ಬೀಳಬಹುದು.', 'hazard'],
  ['drainage', 'en', 'Culvert blocked', 'The culvert under the road near the temple is blocked with branches.'],
  ['drainage', 'en', 'Drain wall collapsed', 'The side wall of the open drain has collapsed onto the footpath.'],
  ['drainage', 'en', 'Mosquito breeding in drain', 'The drain next to the school is full of stagnant water and mosquito larvae.'],
  // other civic (8)
  ['other', 'en', 'Fallen tree branch', 'A big tree branch has fallen on the footpath near the park. People walk on the road.'],
  ['other', 'en', 'Stray cattle on road', 'Cattle sit in the middle of the road near the market every evening and cause accidents.'],
  ['other', 'en', 'Bus shelter roof broken', 'The roof of the bus shelter near the college is broken. No shelter from rain.'],
  ['other', 'en', 'Public toilet locked', 'The public toilet near the bus stand has been locked for a month.'],
  ['other', 'en', 'Park benches broken', 'Most benches in the children’s park are broken.'],
  ['other', 'hi', 'आवारा कुत्ते', 'हमारी गली में आवारा कुत्तों का झुंड बच्चों पर भौंकता और दौड़ता है।'],
  ['other', 'kn', 'ಮರ ಬಿದ್ದಿದೆ', 'ಪಾರ್ಕ್ ಹತ್ತಿರ ದೊಡ್ಡ ಮರದ ಕೊಂಬೆ ಫುಟ್‌ಪಾತ್ ಮೇಲೆ ಬಿದ್ದಿದೆ.'],
  ['other', 'en', 'Illegal hoardings', 'Huge illegal hoardings are blocking the view at the junction.'],
  // spam (6) and not-civic (8)
  ['other', 'en', 'Best home loan offer', 'Get instant home loans at the lowest rates. Call now 9876543210 or visit www.fast-loans-offer.xyz', 'spam'],
  ['other', 'en', 'asdf test', 'asdfghjkl qwerty test test test test test test', 'spam'],
  ['other', 'en', 'Earn money from home', 'Work from home and earn Rs 50000 per month!!! WhatsApp me for details', 'spam'],
  ['other', 'hi', 'सस्ता लोन', 'सबसे सस्ता लोन पाएं, अभी कॉल करें 9123456780', 'spam'],
  ['other', 'en', 'hello', 'hello hello hello hello is this working hello hello', 'spam'],
  ['other', 'en', 'Follow my page', 'Follow my instagram page for daily memes, click here bit.ly/xyz123', 'spam'],
  ['other', 'en', 'Neighbour plays loud music', 'My neighbour plays loud music every night until 1 am. I cannot sleep.'],
  ['other', 'en', 'Shop overcharging', 'The grocery shop near my house charges more than MRP for milk.'],
  ['other', 'en', 'Mobile network poor', 'Mobile network signal is very poor in our area for weeks.'],
  ['other', 'en', 'Lost my wallet', 'I lost my wallet at the bus stand yesterday evening, please help me find it.'],
  ['other', 'hi', 'पड़ोसी से झगड़ा', 'मेरा पड़ोसी अपनी कार मेरे गेट के सामने खड़ी करता है।'],
  ['other', 'en', 'Internet down', 'My home broadband has not worked for three days.'],
  ['other', 'kn', 'ಬಾಡಿಗೆ ಸಮಸ್ಯೆ', 'ಮನೆ ಮಾಲೀಕರು ಮುಂಗಡ ಹಣ ವಾಪಸ್ ಕೊಡುತ್ತಿಲ್ಲ.'],
  ['other', 'en', 'Bank ATM not working', 'The private bank ATM near the junction has been out of cash for a week.'],
];

// ---- 30 planted duplicates: same problem, same spot, a day or two later, different words or language ----
const DUPLICATES: [number, Lang, string, string][] = [
  [0, 'en', 'Big hole in road at bus stand', 'Huge hole in the road next to the bus stand, scooters are falling into it.'],
  [0, 'hi', 'बस स्टॉप के पास गड्ढा', 'बस स्टॉप के पास सर्विस रोड पर गहरा गड्ढा है, बाइक वाले गिर रहे हैं।'],
  [1, 'en', 'Stones all over school junction road', 'Road near the school junction is completely broken, small stones all over after the rain.'],
  [5, 'kn', 'ಹೆದ್ದಾರಿಯಲ್ಲಿ ದೊಡ್ಡ ಗುಂಡಿ', 'ಫ್ಲೈಓವರ್ ಹತ್ತಿರ ಹೆದ್ದಾರಿಯ ಮಧ್ಯದಲ್ಲಿ ದೊಡ್ಡ ಗುಂಡಿ ಆಗಿದೆ.'],
  [9, 'en', 'Sunken manhole on main road', 'Manhole on the main road is much lower than the road, every car bangs on it.'],
  [12, 'en', 'Water-filled potholes at bus stop', 'Potholes at the bus stop are full of rainwater, you cannot see them.'],
  [16, 'en', 'Dangerous pothole at bus stand', 'Dangerous pothole near the bus stand, especially at night.'],
  [24, 'en', 'Market garbage piling up', 'Garbage piling up near the market for days, dogs pulling it everywhere.'],
  [24, 'kn', 'ಮಾರುಕಟ್ಟೆಯಲ್ಲಿ ಕಸ', 'ಮಾರುಕಟ್ಟೆ ಹತ್ತಿರ ಕಸ ಹಲವು ದಿನಗಳಿಂದ ಬಿದ್ದಿದೆ.'],
  [25, 'hi', 'बस स्टॉप का कूड़ेदान', 'बस स्टॉप का कूड़ेदान भरकर सड़क पर कचरा फैल रहा है।'],
  [27, 'en', 'Smoke from garbage burning near school', 'Every evening garbage is burnt behind the school and smoke comes into the classrooms.'],
  [29, 'en', 'Fish market waste smell', 'Fish waste lying in the open near the fish market, very bad smell.'],
  [44, 'en', 'Dark at the bus stop', 'No streetlight at the bus stop for many days, totally dark.'],
  [44, 'hi', 'बस स्टॉप पर अंधेरा', 'बस स्टॉप पर कई दिनों से लाइट नहीं जल रही।'],
  [45, 'en', 'School road lights out', 'All the lights on the school road are off, unsafe at night.'],
  [48, 'en', 'Snapped cable near school', 'Electric cable from the streetlight is hanging low near the school gate, sparks earlier.'],
  [48, 'kn', 'ಶಾಲೆ ಹತ್ತಿರ ತಂತಿ', 'ಶಾಲೆಯ ಹತ್ತಿರ ಬೀದಿ ದೀಪದ ತಂತಿ ಕೆಳಗೆ ನೇತಾಡುತ್ತಿದೆ.'],
  [49, 'en', 'Pole about to fall', 'The light pole at the market is tilting and might fall any time.'],
  [62, 'en', 'Water leaking near hospital', 'Water pipe leak near the hospital, water flowing on the road all day.'],
  [63, 'kn', 'ನೀರು ಪೂರೈಕೆ ಇಲ್ಲ', 'ನಮ್ಮ ಬೀದಿಗೆ ಎರಡು ದಿನದಿಂದ ನೀರು ಬಂದಿಲ್ಲ.'],
  [64, 'en', 'Smelly tap water', 'Tap water is dirty and smells bad, kids are sick.'],
  [66, 'hi', 'मेन पाइप फटा', 'चौराहे के पास पानी की मेन पाइप फट गई है, सड़क पर बाढ़ जैसा पानी है।'],
  [80, 'en', 'Flooding due to blocked drain', 'Road floods after rain because the drain is full of plastic, water entered shops.'],
  [81, 'en', 'Market drain overflowing', 'Sewage overflowing from the drain at the market, terrible smell.'],
  [82, 'en', 'Manhole open on main road', 'No cover on the manhole on the main road, full of water, very dangerous.'],
  [82, 'kn', 'ಮ್ಯಾನ್‌ಹೋಲ್ ತೆರೆದಿದೆ', 'ಮುಖ್ಯ ರಸ್ತೆಯಲ್ಲಿ ಮ್ಯಾನ್‌ಹೋಲ್ ಮುಚ್ಚಳ ಇಲ್ಲ.'],
  [85, 'en', 'Sewage backflow in homes', 'Drain water comes back into our houses whenever it rains heavily.'],
  [88, 'en', 'Junction flooded again', 'Knee-deep water at the junction after rain, drains are blocked.'],
  [98, 'en', 'Branch on footpath at park', 'Tree branch lying across the footpath next to the park.'],
  [99, 'en', 'Cows on market road', 'Stray cows sit on the market road every evening, very risky for bikes.'],
];

export const CASES: EvalCase[] = [
  ...BASE.map(([category, lang, title, description, flag], i) => ({
    id: `B${String(i).padStart(3, '0')}`,
    title,
    description,
    lang,
    expected: { category, hazard: flag === 'hazard', spam: flag === 'spam' },
  })),
  ...DUPLICATES.map(([of, lang, title, description], i) => {
    const base = BASE[of]!;
    return { id: `D${String(i).padStart(3, '0')}`, title, description, lang, expected: { category: base[0], hazard: base[4] === 'hazard', spam: false }, duplicateOf: `B${String(of).padStart(3, '0')}` };
  }),
];
