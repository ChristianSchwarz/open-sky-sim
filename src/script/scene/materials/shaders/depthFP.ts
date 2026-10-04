import { DITHER_PARS_FRAGMENT } from './dither';
import { LOG_DEPTH_FRAGMENT, LOG_DEPTH_PARS_FRAGMENT } from './logDepth';
import { RAIL_SLEEPER_PITCH_M, TRACK_LONG_TIMBER_EXTRA_M, TRACK_LONG_TIMBER_STEP_M } from '../../../terrain/ptr';

const glsl = (v: number) => v.toFixed(4);

/**
 * The track drawn into a railway stroke. Real dimensions, metres: standard
 * gauge with the rail head centred half a head outside it, concrete sleepers
 * 2.6 m long and 0.26 m wide at RAIL_SLEEPER_PITCH_M, one track per
 * RAIL_TRACK_PITCH_M of bed (RAIL_TRACK_WIDTH_M in bake_osm_roads.py, so a
 * way tagged two tracks wide draws two).
 */
const RAIL_HEAD_OFFSET_M = 0.7175;
const RAIL_HEAD_HALF_M = 0.0375;
const SLEEPER_HALF_LENGTH_M = 1.3;
const SLEEPER_HALF_WIDTH_M = 0.13;
const RAIL_TRACK_PITCH_M = 5.0;
/**
 * Pixel footprint, metres, over which the track fades in: full detail
 * finer than the first, none coarser than the second. Out to a pixel of
 * nearly four sleeper pitches (2x again at the user's request): the sleepers are box-filtered as a whole train
 * (sleeperCoverage), so where a pixel spans several they settle into an
 * even paler tint instead of shimmering, and the rails into a faint line.
 */
const RAIL_DETAIL_FADE_M: readonly [number, number] = [0.8, 2.4];
/**
 * Least strength a rail keeps once it is thinner than a pixel: exact
 * coverage of a 7.5 cm head fades to a few percent by the far end of the
 * fade, and the rails are what reads as railway from there. Drawn at least
 * half a pixel wide at this share instead.
 */
const RAIL_MIN_STRENGTH = 0.45;

/**
 * Exact coverage of a pixel `fp` wide, centred `d` from the middle of a box
 * `h` either side of it, so a rail head thinner than a pixel draws as a
 * faint line instead of crawling.
 */
const BOX_COVERAGE = `
  float boxCoverage(float d, float h, float fp) {
    float overlap = min(d + fp * 0.5, h) - max(d - fp * 0.5, -h);
    return clamp(overlap / fp, 0.0, 1.0);
  }

  // Running integral of a pulse train of duty d per unit period, on for
  // fract(t) < d.
  float pulseIntegral(float t, float d) {
    return floor(t) * d + min(fract(t), d);
  }

  // Share of a pixel fp metres long, at alongM, that falls on a sleeper:
  // the sleeper train box-filtered exactly, however many sleepers the
  // pixel spans. Shifted so a sleeper is centred on each half pitch.
  float sleeperCoverage(float alongM, float pitch, float halfWidth, float fp) {
    float d = 2.0 * halfWidth / pitch;
    float t = alongM / pitch - 0.5 + 0.5 * d;
    float h = 0.5 * fp / pitch;
    return clamp((pulseIntegral(t + h, d) - pulseIntegral(t - h, d)) / (2.0 * h), 0.0, 1.0);
  }
`;

/**
 * How far a long timber under a turnout reaches past an ordinary sleeper,
 * toward the diverging track, metres: past its outer rail where the switch
 * zone ends (TURNOUT_ZONE_OFFSET_M in bake_osm_roads.py, plus a rail and a
 * margin).
 */
const LONG_TIMBER_EXTRA_M = TRACK_LONG_TIMBER_EXTRA_M;

/**
 * Three passes over one stroke (uRailPass): 0 the bed, opaque; 1 the
 * sleepers and 2 the rails, each as coverage in alpha. Every bed is drawn
 * before any sleeper and every sleeper before any rail, so where two strokes
 * overlap - a turnout, a diamond crossing, a passing loop a few metres off
 * the main line - the rails of both lie on top: in one detail pass a long
 * timber of the through track drawn after the diverging track cut its rails
 * into dashes.
 *
 * vTrack carries the switch-zone flags (see ptr.ts TRACK_FLAG_*): x no
 * sleepers of its own (the diverging track over the through track's
 * timbers), y and z long timbers toward the positive and negative side,
 * w a level crossing: no bed and no sleepers, so the road drawn under it
 * shows with the rails over it.
 */
const RAIL_FRAGMENT = `
    float railAlpha = 1.0;
    float levelCrossing = step(0.5, vTrack.w);
    if (uRailPass < 0.5 && levelCrossing > 0.5) {
      discard;
    }
    // A switch zone's bed is widened for the long timbers, which reach to
    // one side only: past an ordinary bed's half-width on the other side it
    // would be bare ballast, so there is none.
    if (uRailPass < 0.5) {
      float bedHalf = ${glsl(RAIL_TRACK_PITCH_M / 2)};
      if ((vTrack.y > 0.5 && vRail.x < -bedHalf) || (vTrack.z > 0.5 && vRail.x > bedHalf)) {
        discard;
      }
    }
    if (uRailPass > 0.5) {
      float acrossM = vRail.x;
      float alongM = vRail.y;
      float halfM = vRail.z;
      float fpA = max(fwidth(acrossM), 1.0e-4);
      float fpL = max(fwidth(alongM), 1.0e-4);
      float detail = 1.0 - smoothstep(${glsl(RAIL_DETAIL_FADE_M[0])}, ${glsl(RAIL_DETAIL_FADE_M[1])}, max(fpA, fpL));
      float noSleeper = max(step(0.5, vTrack.x), levelCrossing);
      float longPos = step(0.5, vTrack.y);
      float longNeg = step(0.5, vTrack.z);
      // A switch zone's bed is widened for the timbers, so its width no
      // longer says how many tracks it holds: it holds one.
      float zone = max(longPos, longNeg);
      float width = 2.0 * halfM;
      float tracks = zone > 0.5 ? 1.0 : max(1.0, floor(width / ${glsl(RAIL_TRACK_PITCH_M)} + 0.5));
      float pitch = width / tracks;
      float local = acrossM + halfM;
      float off = local - (floor(local / pitch) + 0.5) * pitch;
      // Rounded: the level is constant across a zone, but a varying
      // interpolates across the vertex where a zone starts.
      float reach = ${glsl(LONG_TIMBER_EXTRA_M)} + ${glsl(TRACK_LONG_TIMBER_STEP_M)} * floor(vReach + 0.5);
      float lo = -${glsl(SLEEPER_HALF_LENGTH_M)} - reach * longNeg;
      float hi = ${glsl(SLEEPER_HALF_LENGTH_M)} + reach * longPos;
      float sleeper = sleeperCoverage(alongM, ${glsl(RAIL_SLEEPER_PITCH_M)}, ${glsl(SLEEPER_HALF_WIDTH_M)}, fpL)
          * boxCoverage(off - 0.5 * (lo + hi), 0.5 * (hi - lo), fpA) * (1.0 - noSleeper);
      float railHalf = max(${glsl(RAIL_HEAD_HALF_M)}, 0.25 * fpA);
      float rail = boxCoverage(abs(abs(off) - ${glsl(RAIL_HEAD_OFFSET_M)}), railHalf, fpA)
          * max(${glsl(RAIL_HEAD_HALF_M)} / railHalf, ${glsl(RAIL_MIN_STRENGTH)});
      // Shades of the bed colour, so every palette and time of day keeps
      // its own: concrete paler than the ballast, the worn rail head
      // brightest of all.
      vec3 bed = diffuse;
      bool rails = uRailPass > 1.5;
      railAlpha = (rails ? rail : sleeper) * detail;
      if (railAlpha < 0.004) {
        discard;
      }
      diffuse = rails ? min(bed * 2.4 + 0.08, vec3(1.0)) : min(bed * 1.6, vec3(1.0));
    }
`;

/**
 * highp, not lowp: this program writes the logarithmic gl_FragDepth, and the
 * surfaces it draws - road strokes, runways, rivers - lie on the terrain and
 * win or lose the depth test against it by centimetres. Desktop GPUs run lowp
 * as fp32 anyway, which hid it; Android GPUs honour it (fp16 or less), the
 * depth came out coarser than the highp terrain's and every overlay vanished
 * under the ground. The fog distance needs the range too.
 */
const shader = (kind: 'stroke' | 'flat' | 'rail'): string => {
  const flat = kind === 'flat';
  const rail = kind === 'rail';
  return `
  precision highp float;

  uniform vec3 vCameraPos;
  uniform vec3 vCameraNormal;
  uniform float vCameraD;
  uniform int shadingType;
  uniform vec3 color;
  uniform vec3 colorSecondary;
  uniform int fogType;
  uniform float fogDensity;
  uniform vec3 fogColor;
  uniform float alphaDither;
  uniform float colorDither;
  uniform float overbright;
  uniform float uGrazingHighlight;
  uniform vec3 uSunTint;

  varying vec3 vPosition;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
` + (flat ? `
  uniform sampler2D uMap;
  uniform float uMarkings;
  uniform vec3 uMarkColorA;
  uniform vec3 uMarkColorB;
  uniform float uMaxFootprint;
  uniform vec2 uMarkFade;
  varying vec2 vUv;
` : '') + (rail ? `
  uniform float uRailPass;
  varying vec3 vRail;
  varying vec4 vTrack;
  varying float vReach;
${BOX_COVERAGE}
` : '') + `
${LOG_DEPTH_PARS_FRAGMENT}
${DITHER_PARS_FRAGMENT}
  void main() {
    vec2 screen = gl_FragCoord.xy;
` + (flat ? `
    // Paint drawn as geometry gives way to its texture once a pixel is wider
    // than it can be drawn cleanly at. The larger of the two ground axes, so
    // a grazing view - where the paint is foreshortened to nothing along the
    // line of sight - hands over first.
    if (uMaxFootprint > 0.0) {
      vec2 footprint = fwidth(vPosition.xz);
      if (max(footprint.x, footprint.y) > uMaxFootprint) {
        discard;
      }
    }
` : '') + `
    // A grazing view also thickens the dither, not just brightens it - real
    // glass looks progressively more solid (not just whiter) the more
    // edge-on it is, and a sparse dither at the rim undersells the effect.
    float rim = 0.0;
    if (uGrazingHighlight > 0.5) {
      vec3 grazeNormal = normalize(vNormalView);
      vec3 grazeView = normalize(vViewDir);
      float facing = abs(dot(grazeNormal, grazeView));
      rim = 1.0 - smoothstep(0.0, 0.65, facing);
    }
    float effectiveAlphaDither = alphaDither + rim * 0.55;

    if (effectiveAlphaDither > 0.001) {
      float alpha = effectiveAlphaDither + bayerThreshold(screen);
      if (alpha < 0.5) {
        discard;
      }
    }

    float distance = 0.0;
    float fogSteps = 12.0;

    if (fogType == 1) {
      distance = dot(vPosition, vCameraNormal) + vCameraD;
    } else if (fogType == 2) {
      vec3 dV = vPosition - vCameraPos;
      distance = sqrt(dot(dV, dV));
      fogSteps = 24.0;
    }

    float fogFactor = exp2(-fogDensity * distance);
    fogFactor = 1.0 - clamp(fogFactor, 0.0, 1.0);
    if (shadingType != 3) {
      fogFactor = floor(fogFactor * fogSteps + 0.5) / fogSteps;
    }

    vec3 diffuse;
    if (colorDither > 0.5 || (shadingType == 0 && colorDither > -0.5)) {
      // colorDither: 1 = force two-tone stipple, 0 = duotone-only, -1 = solid primary.
      bool dithering = mod(floor(screen.x + screen.y), 2.0) > 0.5;
      diffuse = dithering ? color : colorSecondary;
    } else {
      diffuse = color;
    }
` + (flat ? `
    // A runway's paint, as mipmapped coverage: the first tone under the
    // second, both over the pavement. Faded out close in, where the paint is
    // drawn as geometry and the magnified texture would only blur its edges;
    // full strength by the footprint the geometry gives way at.
    if (uMarkings > 0.5) {
      vec2 markFootprint = fwidth(vPosition.xz);
      float markWeight = smoothstep(uMarkFade.x, uMarkFade.y,
        max(markFootprint.x, markFootprint.y));
      vec2 paint = texture2D(uMap, vUv).rg * markWeight;
      diffuse = mix(diffuse, uMarkColorA, paint.r);
      diffuse = mix(diffuse, uMarkColorB, paint.g);
    }
` : '') + (rail ? RAIL_FRAGMENT : '') + `
    // Real glass gets noticeably more reflective toward a grazing view - a
    // canopy pane read as uniformly dark from every angle otherwise. Blends
    // toward the sun's own colour (rim computed above, alongside the dither
    // density boost) rather than a fixed white, the way a canopy actually
    // glints with whatever light it's catching - amber at sunset, blue-white
    // at noon - rather than a flat highlight that never changes with the sky.
    if (rim > 0.001) {
      diffuse = mix(diffuse, uSunTint, rim);
    }

    // Light sources first: a palette entry stops at white, which is nowhere
    // near enough for the sun, so it is scaled up and left to clip the way a
    // light does rather than sitting wherever the palette left it.
    diffuse *= overbright;
    gl_FragColor = mix(vec4(diffuse, 1.0), vec4(fogColor, 1.0), fogFactor * 0.92);
` + (rail ? `    gl_FragColor.a = railAlpha;
` : '') + `${LOG_DEPTH_FRAGMENT}
  }
`;
};

export const DepthFragProgram: string = shader('stroke');
/**
 * The same, for the flat mesh programs: adds the runway marking mask and the
 * footprint cutoff, which read a `vUv` only flatVP writes.
 */
export const FlatDepthFragProgram: string = shader('flat');
/** The same, for a railway stroke: draws the track close up (see RAIL_FRAGMENT). */
export const RailDepthFragProgram: string = shader('rail');
