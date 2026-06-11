// sprite-data.js — Max Holloway UFC 300, v15: FROM SCRATCH. 160x224.
// Architecture fixes vs every prior version:
//   1. ONE light source (upper-left). No mirrored shading anywhere — the
//      whole left of the figure is lit, the right is shaded, and every limb
//      is painted as a shaded cylinder (highlight band near its lit edge).
//   2. Organic contours — all edges are cosine-eased curves, limbs bow.
//   3. McGregor formula — small featureless head (planes + fade + goatee),
//      detail budget spent on body, tattoos, shorts.
//   4. Depth — fists drawn in front of the shorts; ground shadow.

const PALETTE = {
  o: [52, 30, 26, 255],     // silhouette outline (dark brown)
  P: [252, 220, 178, 255],  // skin brightest
  S: [244, 202, 158, 255],  // skin highlight
  s: [228, 176, 130, 255],  // skin base (tan)
  t: [196, 138, 96, 255],   // skin shade
  u: [150, 96, 64, 255],    // skin deep shade
  U: [112, 64, 44, 255],    // deepest skin / interior separations
  h: [44, 34, 28, 255],     // hair dark
  i: [78, 58, 44, 255],     // hair highlight
  f: [122, 92, 70, 255],    // fade scalp / stubble
  k: [46, 52, 60, 255],     // tattoo ink dark
  K: [92, 100, 110, 255],   // tattoo ink mid
  w: [243, 243, 239, 255],  // shorts white
  x: [208, 208, 201, 255],  // white shade
  y: [170, 170, 162, 255],  // white deep shade
  r: [196, 58, 56, 255],    // hibiscus red
  R: [228, 118, 106, 255],  // hibiscus red light
  n: [46, 76, 128, 255],    // hibiscus navy
  N: [92, 126, 180, 255],   // navy light
  l: [86, 132, 84, 255],    // leaf green
  g: [38, 36, 40, 255],     // glove black
  G: [80, 76, 86, 255],     // glove highlight
  b: [40, 100, 182, 255],   // glove cuff blue
  W: [248, 248, 248, 255],  // white (UFC panel)
  z: [24, 20, 20, 80],      // ground shadow (translucent)
};

const WIDTH = 160, HEIGHT = 224;
const grid = [];
for (let i = 0; i < HEIGHT; i++) grid.push(Array(WIDTH).fill('.'));

// ---- helpers -----------------------------------------------------------------
const SKIN = 'PSstuU';
const isSkin = (ch) => SKIN.includes(ch);
function hash2(x, y) {
  let hv = (x * 374761393 + y * 668265263) | 0;
  hv = ((hv ^ (hv >>> 13)) * 1274126177) | 0;
  return ((hv ^ (hv >>> 16)) >>> 0);
}
// cosine-eased path through [row, value] keypoints — organic curved contours
function cpath(pts) {
  return (y) => {
    if (y <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (y <= pts[i][0]) {
        const [y0, v0] = pts[i - 1], [y1, v1] = pts[i];
        const t = (y - y0) / (y1 - y0);
        const e = (1 - Math.cos(Math.PI * t)) / 2;
        return Math.round(v0 + (v1 - v0) * e);
      }
    }
    return pts[pts.length - 1][1];
  };
}
// one-step-darker map for the shaded (right) side of the body
const DARK = { P: 'S', S: 's', s: 't', t: 'u', u: 'U', U: 'U', w: 'x', x: 'y', y: 'y' };
// cylinder shading: light enters from the left of every form
function skinRamp(xf, wide) {
  if (xf < 0.08) return 's';
  if (xf < 0.18) return wide ? 'P' : 'S';
  if (xf < 0.36) return 'S';
  if (xf < 0.62) return 's';
  if (xf < 0.84) return 't';
  return 'u';
}
function whiteRamp(xf) {
  if (xf < 0.55) return 'w';
  if (xf < 0.82) return 'x';
  return 'y';
}
// paint one row-span of a limb/segment as a shaded cylinder
function span(yy, L, R, ramp, dark, noOutline) {
  for (let x = L; x <= R; x++) {
    let ch;
    if ((x === L || x === R) && !noOutline) ch = 'o';
    else {
      ch = ramp((x - L) / Math.max(1, R - L), R - L >= 14);
      if (dark) ch = DARK[ch] || ch;
    }
    grid[yy][x] = ch;
  }
}
function putRow(r, parts) {
  for (const [c, str] of parts) for (let i = 0; i < str.length; i++) grid[r][c + i] = str[i];
}
function patch(yy, x0, str) {        // overlay tones onto existing skin only
  for (let i = 0; i < str.length; i++) {
    if (isSkin(grid[yy][x0 + i])) grid[yy][x0 + i] = str[i];
  }
}

// ---- HEAD rows 16-45: small, featureless, lit from the left -----------------
putRow(16, [[75, 'oooooooooo']]);
putRow(17, [[73, 'oo'], [75, 'ihhhhhhhhh'], [85, 'o']]);
putRow(18, [[71, 'oo'], [73, 'iihhhhhhhhhhh'], [86, 'oo']]);
putRow(19, [[70, 'o'], [71, 'ihhhhhhhhhhhhhhh'], [87, 'o']]);
putRow(20, [[69, 'o'], [70, 'ihhhhhhhhhhhhhhhhh'], [88, 'o']]);
putRow(21, [[69, 'o'], [70, 'hhhhhhhhhhhhhhhhhh'], [88, 'o']]);
// M hairline: lit forehead left, shaded right, fade at temples
putRow(22, [[68, 'o'], [69, 'hh'], [71, 'f'], [72, 'Sss'], [75, 'ss'], [77, 'hhhh'], [81, 'tt'], [83, 'tt'], [85, 'f'], [86, 'hh'], [88, 'o']]);
putRow(23, [[68, 'o'], [69, 'h'], [70, 'f'], [71, 'Sssssss'], [78, 'ss'], [80, 'tttttt'], [86, 'fh'], [88, 'o']]);
putRow(24, [[68, 'o'], [69, 'f'], [70, 'Sssssssss'], [79, 'ss'], [81, 'ttttt'], [86, 'ff'], [88, 'o']]);
// brow plane + sockets (planes, not features)
putRow(25, [[68, 'o'], [69, 'f'], [70, 's'], [71, 'tttttt'], [77, 'ss'], [79, 't'], [80, 'uuuuu'], [85, 'tt'], [87, 'f'], [88, 'o']]);
putRow(26, [[68, 'o'], [69, 's'], [70, 's'], [71, 'uuuuu'], [76, 'ts'], [78, 'ss'], [80, 'uuuuuu'], [86, 't'], [87, 't'], [88, 'o']]);
putRow(27, [[68, 'o'], [69, 'ss'], [71, 'ttttt'], [76, 'ss'], [78, 'sst'], [81, 'ttttt'], [86, 'tt'], [88, 'o']]);
// cheekbones (lit left S, shaded right) + nose plane (shadow to its right)
putRow(28, [[66, 'oo'], [68, 'S'], [69, 'Ss'], [71, 'ssssss'], [77, 'ss'], [79, 'st'], [81, 'sttt'], [85, 'tt'], [87, 'u'], [88, 'o'], [89, 'oo']]);
putRow(29, [[65, 'o'], [66, 'st'], [68, 'Sss'], [71, 'ssssss'], [77, 'ss'], [79, 'st'], [81, 'tttt'], [85, 'tu'], [87, 'u'], [88, 'o'], [89, 'o'], [90, 'to']]);
putRow(30, [[65, 'o'], [66, 'tt'], [68, 'sss'], [71, 'sssss'], [76, 'sss'], [79, 'st'], [81, 'tttt'], [85, 'uu'], [87, 'u'], [88, 'o'], [89, 'o'], [90, 'uo']]);
putRow(31, [[66, 'oo'], [68, 'sss'], [71, 'sssss'], [76, 'ss'], [78, 's'], [79, 'u'], [80, 'tt'], [82, 'ttt'], [85, 'uu'], [87, 'u'], [88, 'o']]);
// mustache + lip-shadow plane + goatee mass (longer Holloway chin)
putRow(32, [[68, 'o'], [69, 'ss'], [71, 'ss'], [73, 'hhhhhhhhhh'], [83, 'tt'], [85, 'uu'], [87, 'o']]);
putRow(33, [[68, 'o'], [69, 'ss'], [71, 's'], [72, 'hhhhhhhhhhhh'], [84, 'tu'], [86, 'u'], [87, 'o']]);
putRow(34, [[68, 'o'], [69, 'ss'], [71, 's'], [72, 'tt'], [74, 'uuuuuuuu'], [82, 'tt'], [84, 'hh'], [86, 'u'], [87, 'o']]);
putRow(35, [[69, 'o'], [70, 'ss'], [72, 'hhhhhhhhhhhh'], [84, 'hu'], [86, 'o']]);
putRow(36, [[69, 'o'], [70, 's'], [71, 'hhhhhhhhhhhhhh'], [85, 'o']]);
putRow(37, [[70, 'o'], [71, 'hhhhhhhhhhhhhh'], [85, 'o']]);
putRow(38, [[71, 'o'], [72, 'hhhhhhhhhhhh'], [84, 'o']]);
putRow(39, [[72, 'o'], [73, 'hhhhhhhhhh'], [83, 'o']]);
putRow(40, [[74, 'oo'], [76, 'hhhhhh'], [82, 'o']]);
// under-chin + neck (cylinder, lit left) + trap wedges rising
putRow(41, [[74, 'o'], [75, 'uuuuuuuuu'], [84, 'o']]);
putRow(42, [[74, 'o'], [75, 'Sssstttuu'], [84, 'o']]);
putRow(43, [[74, 'o'], [75, 'Sssstttuu'], [84, 'o']]);
putRow(44, [[74, 'o'], [75, 'Sssstttuu'], [84, 'o']]);
putRow(45, [[70, 'oooo'], [74, 'sssssttuuu'], [84, 'oooo']]);
putRow(46, [[67, 'ooo'], [70, 'Sss'], [73, 'ssssstttuu'], [83, 'ttt'], [86, 'ooo']]);
putRow(47, [[64, 'ooo'], [67, 'Ssssss'], [73, 'ssssstttuu'], [83, 'tttuu'], [88, 'ooo']]);
putRow(48, [[62, 'oo'], [64, 'Sssssssss'], [73, 'ssssstttuu'], [83, 'ttuuuu'], [89, 'oo']]);

// stubble speckle on the lean cheeks/jaw
for (let yy = 28; yy <= 35; yy++) {
  for (const [c0, c1] of [[68, 72], [83, 87]]) {
    for (let x = c0; x <= c1; x++) {
      if (isSkin(grid[yy][x]) && hash2(x, yy) % 6 === 0) grid[yy][x] = 'f';
    }
  }
}

// ---- TORSO rows 49-121 (one shaded mass, V-taper, curved edges) -------------
const torsoL1 = cpath([[49, 60], [52, 52], [55, 47], [60, 45], [66, 45]]);     // delt bulge left
const torsoR1 = cpath([[49, 99], [52, 107], [55, 112], [60, 114], [66, 114]]); // delt bulge right
const torsoL2 = cpath([[67, 58], [85, 59], [105, 61], [121, 63]]);             // lat line left
const torsoR2 = cpath([[67, 101], [85, 100], [105, 98], [121, 96]]);           // lat line right
for (let yy = 49; yy <= 66; yy++) span(yy, torsoL1(yy), torsoR1(yy), skinRamp, false);
for (let yy = 67; yy <= 121; yy++) span(yy, torsoL2(yy), torsoR2(yy), skinRamp, false);

// collarbones (lit left dash, dark right dash)
patch(50, 66, 'uuuuu'); patch(51, 62, 'uuu');
patch(50, 88, 'UUUUU'); patch(51, 94, 'UUU');
// pec under-arcs (right pec darker) + sternum
patch(76, 61, 'uuuu'); patch(77, 64, 'uuuuuu'); patch(78, 69, 'uuuuuuu');
patch(75, 89, 'UUUU'); patch(76, 84, 'UUUUUU'); patch(77, 80, 'UUU');
for (let yy = 58; yy <= 112; yy++) { if (isSkin(grid[yy][80])) grid[yy][80] = (yy <= 78 ? 'u' : 't'); }
// abs: lit cells left of center, shaded cells right
for (const y0 of [90, 98, 106]) {
  patch(y0, 72, 'SSSSS'); patch(y0 + 1, 72, 'SSSSs'); patch(y0 + 3, 72, 'ttttt');
  patch(y0, 82, 'sssss'); patch(y0 + 1, 82, 'ssstt'); patch(y0 + 3, 82, 'uuuuu');
}
patch(112, 78, 'uu');
// obliques
patch(110, 64, 'uu'); patch(114, 65, 'uu'); patch(109, 93, 'UU'); patch(113, 92, 'UU');

// ---- ARMS rows 60-109 (bowed cylinders; fists drawn later, over shorts) -----
const armLL = cpath([[60, 45], [70, 41], [78, 40], [86, 42], [96, 46], [109, 49]]);  // left arm outer
const armLR = cpath([[60, 57], [70, 55], [78, 54], [86, 55], [96, 57], [109, 59]]);  // left arm inner
const armRL = cpath([[60, 103], [70, 105], [78, 106], [86, 105], [96, 103], [109, 101]]); // right inner
const armRR = cpath([[60, 115], [70, 119], [78, 120], [86, 118], [96, 114], [109, 111]]); // right outer
for (let yy = 60; yy <= 109; yy++) {
  if (yy >= 67) {  // separate from the torso mass below the delts
    span(yy, armLL(yy), armLR(yy), skinRamp, false);
    span(yy, armRL(yy), armRR(yy), skinRamp, true);
  }
}
// cuffs (blue) overwrite the wrist rows
for (let yy = 106; yy <= 109; yy++) {
  for (let x = armLL(yy); x <= armLR(yy); x++) if (isSkin(grid[yy][x])) grid[yy][x] = 'b';
  for (let x = armRL(yy); x <= armRR(yy); x++) if (isSkin(grid[yy][x])) grid[yy][x] = 'b';
}
// bicep highlights (left arm bright, right arm muted) + elbow shadows
for (let yy = 70; yy <= 80; yy++) patch(yy, armLL(yy) + 2, 'PS');
for (let yy = 70; yy <= 80; yy++) patch(yy, armRL(yy) + 2, 's');
for (let yy = 84; yy <= 88; yy++) { patch(yy, armLR(yy) - 2, 'u'); patch(yy, armRR(yy) - 2, 'U'); }

// ---- TATTOOS (form-following ink over the asymmetric shading) ---------------
function ink(r0, r1, c0, c1, skipRows, darkRows, teethRows) {
  for (let yy = r0; yy <= r1; yy++) {
    if (skipRows.has(yy)) continue;
    for (let x = c0; x <= c1; x++) {
      const ch = grid[yy][x];
      if (!isSkin(ch)) continue;
      if (hash2(x, yy) % 13 < 1) continue;
      let tooth = false;
      for (const tr of teethRows) {
        const dy = yy - tr;
        if (dy >= 0 && dy < 4) {
          const m = (x - c0) % 8;
          if (m >= dy && m <= 6 - dy) tooth = true;
        }
      }
      if (tooth || darkRows.has(yy)) grid[yy][x] = 'k';
      else grid[yy][x] = 'PSs'.includes(ch) ? 'K' : 'k';
    }
  }
}
ink(49, 78, 59, 100, new Set([60, 61, 72, 73]), new Set([52, 53]), [56, 66]);        // chest plate
ink(49, 105, 36, 59, new Set([58, 59, 72, 73, 86, 87, 98, 99]), new Set([52, 53, 64, 65, 78, 79, 92, 93]), [54, 68, 82]); // FULL left sleeve
ink(49, 70, 100, 124, new Set([58, 59]), new Set([52, 53, 64, 65]), [55]);            // right shoulder cap
for (let yy = 80; yy <= 92; yy++) {                                                    // sternum strip
  for (const x of [77, 84]) if (isSkin(grid[yy][x])) grid[yy][x] = 'k';
  for (let x = 78; x <= 83; x++) if (isSkin(grid[yy][x]) && hash2(x, yy) % 13 > 4) grid[yy][x] = 'K';
}
for (const [yy, xs] of [[86, [90, 94]], [87, [89, 90, 91, 93, 94, 95]], [88, [91, 92, 93]], [89, [92]]]) {
  for (const x of xs) if (isSkin(grid[yy][x])) grid[yy][x] = 'k';                      // rib bird
}

// ---- WAISTBAND rows 118-124 + SHORTS rows 124-163 ----------------------------
for (let yy = 118; yy <= 124; yy++) {
  const L = 63, R = 97;
  for (let x = L; x <= R; x++) grid[yy][x] = (x === L || x === R) ? 'o' : 'g';
}
for (let yy = 118; yy <= 124; yy++) for (let x = 74; x <= 87; x++) grid[yy][x] = 'W';
const ufc = [
  [119, [75, 77, 79, 80, 81, 84, 85, 86]],
  [120, [75, 77, 79, 83]],
  [121, [75, 77, 79, 80, 83]],
  [122, [75, 76, 77, 79, 83, 84, 85, 86]],
];
for (const [yy, xs] of ufc) for (const x of xs) grid[yy][x] = 'r';

const shL = cpath([[124, 61], [130, 56], [138, 53], [150, 51], [163, 50]]);
const shR = cpath([[124, 98], [130, 103], [138, 106], [150, 108], [163, 109]]);
const legLin = cpath([[142, 79], [152, 74], [163, 72]]);   // left short-leg inner edge
const legRin = cpath([[142, 82], [152, 87], [163, 89]]);   // right short-leg inner edge
for (let yy = 124; yy <= 163; yy++) {
  if (yy < 142) {
    span(yy, shL(yy), shR(yy), whiteRamp, false);
    if (yy >= 137 && yy <= 141) for (let x = 77; x <= 84; x++) if (grid[yy][x] === 'w' || grid[yy][x] === 'x') grid[yy][x] = 'y';
  } else {
    span(yy, shL(yy), legLin(yy), whiteRamp, false);
    span(yy, legRin(yy), shR(yy), whiteRamp, true);
  }
}
// hem shade + outline
for (let yy = 160; yy <= 162; yy++) {
  for (let x = shL(yy) + 1; x < legLin(yy); x++) if ('wx'.includes(grid[yy][x])) grid[yy][x] = 'y';
  for (let x = legRin(yy) + 1; x < shR(yy); x++) if ('wxy'.includes(grid[yy][x])) grid[yy][x] = 'y';
}
for (let x = shL(163); x <= legLin(163); x++) grid[163][x] = 'o';
for (let x = legRin(163); x <= shR(163); x++) grid[163][x] = 'o';
// cloth fold wedges (one per leg, opposite diagonals)
for (let i = 0; i < 9; i++) {
  for (let j = 0; j < 3; j++) {
    const yy = 144 + i, x = shL(yy) + 4 + Math.floor(i / 2) + j;
    if (grid[yy][x] === 'w') grid[yy][x] = 'x';
  }
}
for (let i = 0; i < 7; i++) {
  for (let j = 0; j < 2; j++) {
    const yy = 146 + i, x = shR(yy) - 6 - Math.floor(i / 2) - j;
    if (grid[yy][x] === 'x' || grid[yy][x] === 'w') grid[yy][x] = 'y';
  }
}
// blossoms, leaves, buds
function blossom(cy, cx, c, C) {
  const pat = ['..' + c + c + c + '..', '.' + c + c + c + c + c + '.',
               c + c + C + C + C + c + c, c + c + C + C + C + c + c,
               '.' + c + c + c + c + c + '.', '..' + c + c + c + '..'];
  for (let dy = 0; dy < pat.length; dy++) for (let dx = 0; dx < 7; dx++) {
    const ch = pat[dy][dx];
    if (ch === '.') continue;
    const yy = cy + dy, x = cx + dx;
    if (grid[yy] && 'wxy'.includes(grid[yy][x])) grid[yy][x] = ch;
  }
}
function leaf(cy, cx) {
  for (const [dy, dx] of [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]]) {
    const yy = cy + dy, x = cx + dx;
    if (grid[yy] && 'wxy'.includes(grid[yy][x])) grid[yy][x] = 'l';
  }
}
blossom(126, 66, 'r', 'R');   leaf(127, 74);
blossom(128, 90, 'n', 'N');   leaf(134, 88);
blossom(134, 71, 'n', 'N');   leaf(133, 63);
blossom(136, 97, 'r', 'R');   leaf(142, 101);
blossom(145, 55, 'r', 'R');   leaf(144, 63);
blossom(151, 60, 'n', 'N');   leaf(153, 56);
blossom(149, 91, 'n', 'N');   leaf(155, 99);
blossom(156, 51, 'r', 'R');
blossom(155, 100, 'r', 'R');
for (const [yy, x, c] of [[125, 71, 'n'], [132, 80, 'r'], [133, 58, 'r'], [131, 103, 'n'], [158, 68, 'n'], [159, 95, 'r']]) {
  if ('wxy'.includes(grid[yy][x])) { grid[yy][x] = c; if ('wxy'.includes(grid[yy][x + 1])) grid[yy][x + 1] = c; }
}

// ---- LEGS rows 164-217 (curved, thick, wide stance) ---------------------------
const thLo = cpath([[164, 51], [174, 46], [184, 42], [190, 41]]);   // left thigh outer
const thLi = cpath([[164, 73], [174, 70], [184, 65], [190, 62]]);   // left thigh inner
const shnLo = cpath([[191, 40], [196, 38], [202, 38], [210, 39]]);  // left shin outer (calf bow)
const shnLi = cpath([[191, 61], [198, 57], [206, 53], [210, 52]]);  // left shin inner
const thRo = cpath([[164, 108], [174, 113], [184, 117], [190, 118]]);
const thRi = cpath([[164, 86], [174, 89], [184, 94], [190, 97]]);
const shnRo = cpath([[191, 119], [196, 121], [202, 121], [210, 120]]);
const shnRi = cpath([[191, 98], [198, 102], [206, 106], [210, 107]]);
for (let yy = 164; yy <= 210; yy++) {
  if (yy <= 190) {
    span(yy, thLo(yy), thLi(yy), skinRamp, false);
    span(yy, thRi(yy), thRo(yy), skinRamp, true);
  } else {
    span(yy, shnLo(yy), shnLi(yy), skinRamp, false);
    span(yy, shnRi(yy), shnRo(yy), skinRamp, true);
  }
}
// quads + knees + calves
for (let yy = 166; yy <= 182; yy++) patch(yy, thLo(yy) + 3, yy <= 176 ? 'PSS' : 'SS');
for (let yy = 166; yy <= 182; yy++) patch(yy, thRi(yy) + 3, 'ss');
patch(186, thLo(186) + 4, 'SS'); patch(188, thLo(188) + 4, 'tt');
patch(186, thRi(186) + 4, 'st'); patch(188, thRi(188) + 4, 'uu');
for (let yy = 193; yy <= 202; yy++) patch(yy, shnLo(yy) + 2, 'SS');
for (let yy = 193; yy <= 202; yy++) patch(yy, shnRi(yy) + 2, 'st');
// feet rows 211-217 (pointing outward)
const ftLo = cpath([[211, 36], [213, 28], [216, 26]]);
const ftRo = cpath([[211, 123], [213, 131], [216, 133]]);
for (let yy = 211; yy <= 216; yy++) {
  span(yy, ftLo(yy), 53, skinRamp, false);
  span(yy, 106, ftRo(yy), skinRamp, true);
}
for (let x = ftLo(216); x <= 53; x++) grid[217][x] = grid[216][x] !== '.' ? 'o' : grid[217][x];
for (let x = 106; x <= ftRo(216); x++) grid[217][x] = grid[216][x] !== '.' ? 'o' : grid[217][x];
for (let yy = 213; yy <= 216; yy++) {
  patch(yy, ftLo(yy) + 1, 'tt');
  patch(yy, ftRo(yy) - 2, 'uu');
}

// ---- FISTS rows 110-122 — drawn LAST so they overlap the shorts (depth) -----
function fist(x0, x1, y0, y1, dark) {
  for (let yy = y0; yy <= y1; yy++) {
    for (let x = x0; x <= x1; x++) {
      let ch = 'g';
      if (x === x0 || x === x1 || yy === y0 || yy === y1) ch = 'o';
      else if (yy === y0 + 2 && x > x0 + 1 && x < x1 - 1) ch = dark ? 'g' : 'G';
      else if (yy >= y0 + 4 && yy <= y0 + 6 && ((x - x0) % 3 === 0) && x > x0 + 1 && x < x1 - 1) ch = 'o';
      grid[yy][x] = ch;
    }
  }
}
fist(47, 60, 110, 122, false);
fist(100, 113, 111, 123, true);

// ---- selective outlines: interior 'o' between masses -> deepest skin --------
for (let yy = 40; yy <= 217; yy++) {
  for (let x = 1; x < WIDTH - 1; x++) {
    if (grid[yy][x] !== 'o') continue;
    let interior = true;
    for (let dy = -1; dy <= 1 && interior; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ch = (grid[yy + dy] || [])[x + dx] || '.';
        if (!('PSstuUkKf'.includes(ch) || ch === 'o')) { interior = false; break; }
      }
    }
    if (interior) grid[yy][x] = 'U';
  }
}

// ---- ground shadow ------------------------------------------------------------
for (let yy = 217; yy <= 223; yy++) {
  for (let x = 8; x < WIDTH - 8; x++) {
    if (grid[yy][x] !== '.') continue;
    const dx = (x - 79.5) / 70, dy = (yy - 219.5) / 3.2;
    if (dx * dx + dy * dy <= 1) grid[yy][x] = 'z';
  }
}

// ---- export ---------------------------------------------------------------------
const ROWS = grid.map((row) => row.join(''));
module.exports = { PALETTE, ROWS };
