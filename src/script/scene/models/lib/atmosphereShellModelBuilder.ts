import * as THREE from 'three';
import { EARTH_ATMOSPHERE } from '../../atmosphere/atmosphere';
import { EARTH_MAP_PARS_FRAGMENT, EARTH_MAP_UNIFORMS } from '../../earthMap';
import { SCENE_DEPTH_PARS_FRAGMENT, SCENE_DEPTH_SKY_CUT, SCENE_DEPTH_UNIFORMS } from '../../materials/shaders/sceneDepth';
import { WGS84_A, WGS84_B } from '../../../terrain/geodesy';
import { Model, ModelLibBuilder } from '../models';

/**
 * The atmosphere seen from outside: a full-screen pass over the finished scene.
 *
 * The sky dome is a picture of the air as seen from inside it, painted on a
 * sphere at infinity. From above the air it is the wrong object entirely: the
 * atmosphere becomes a thin luminous shell round a ball, with a bright limb, a
 * terminator, blue-shifted haze over the ground and a sky that goes black
 * overhead. None of that can be baked into a dome, so this pass ray-marches the
 * real thing.
 *
 * Per pixel it takes the view ray, intersects it with the ellipsoid and with a
 * shell round it, and single-scatters along the part of the ray between the
 * eye and whatever ends it - the terrain, read back from the resolved scene
 * depth, or the bare ellipsoid where no terrain has been baked. The result is
 * composited with premultiplied alpha, `dst * transmittance + inscatter`, which
 * is what puts aerial perspective on the terrain and the glowing limb round it
 * in the same pass.
 *
 * It runs in the foreground-sky layer beside the sun's glare, for the same
 * reason: it needs the scene's depth and lies over the scene rather than
 * behind it. Coefficients are the ones the CPU model in atmosphere.ts uses.
 */

/** Top of the atmosphere above the ellipsoid, metres. */
const SHELL_HEIGHT_M = 100_000;

/**
 * Aerosol load seen from outside, against the sky dome's. The CPU model runs a
 * hazy maritime 5x because that is what makes a memorable sunset from the
 * ground; from orbit the same load turns every long slant path milky and hides
 * the surface, and clear air is what the photographs show.
 */
const SHELL_TURBIDITY_SCALE = 0.2;

/**
 * Up to this many baked areas are told apart from the sea-level fill that
 * pads their ancestor tiles out to whole quadrants.
 */
export const SHELL_MAX_AREAS = 8;

/** Width of the blend at an area's edge, degrees of arc (about 55 km). */
const AREA_FEATHER_DEG = 0.5;

/**
 * How far terrain may lie from the ellipsoid and still be believed: the
 * highest ground plus the geoid, with room to spare. A coarse flat tile
 * further out than this is drawn as the globe instead.
 */
const TERRAIN_SLACK_M = 12_000;

/** View-ray samples on each side of the closest approach. */
const VIEW_STEPS = 12;
/** Samples along each sun ray. */
const SUN_STEPS = 5;

const VERTEX_PROGRAM = `
  precision highp float;
  void main() {
    // A quad already in clip space; no camera is involved.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT_PROGRAM = `
  precision highp float;

  uniform mat3 uCamRot;
  uniform vec2 uTanHalfFov;
  /** Ellipsoid centre minus camera, scene axes, metres. */
  uniform vec3 uCentre;
  /** Unit polar axis in scene axes. */
  uniform vec3 uAxis;
  uniform vec3 uSun;
  /** Camera height above the ellipsoid, metres, from doubles on the CPU. */
  uniform float uCamHeight;
  /** 0 = shell off, 1 = full. Faded in with altitude on the CPU. */
  uniform float uWeight;
  /**
   * The same for open sky, which fades in lower and faster: the dome stays a
   * pale day blue however high the camera goes, and fading that into the
   * black of space reads as grey, so the shell's own sky - still blue that
   * low - takes over before it darkens.
   */
  uniform float uSkyWeight;
  /** Exposure multiplier for open sky. */
  uniform float uSkyGain;
  uniform float uExposure;
  /** Radiance of open ocean where no terrain is drawn. */
  uniform vec3 uSurface;
  /** ECEF x (0 N 0 E) and y (0 N 90 E) in scene axes; uAxis is ECEF z. */
  uniform vec3 uEcefX;
  uniform vec3 uEcefY;
  /** Baked areas as (west, south, east, north), radians. */
  uniform vec4 uAreas[${SHELL_MAX_AREAS}];
  uniform int uAreaCount;
  /** How far the globe map is drawn over baked terrain, 0 to 1, by altitude. */
  uniform float uGlobe;
  // The map mode (state/mapView.ts): the globe map outside every baked area
  // and on the bare ellipsoid, nothing over baked terrain, and no air at all.
  uniform float uMapMode;
  // The bake's sea colour: the map's water is drawn in it, so a baked area's
  // sea does not stand out as a darker box in the map's.
  uniform vec3 uMapWater;
${SCENE_DEPTH_PARS_FRAGMENT}

  const float A = ${WGS84_A.toFixed(1)};
  const float SQUASH = ${(WGS84_A / WGS84_B - 1).toFixed(9)};
  const float TOP = ${SHELL_HEIGHT_M.toFixed(1)};
  const vec3 BETA_R = vec3(${EARTH_ATMOSPHERE.rayleighScattering.map(v => v.toExponential(4)).join(', ')});
  const float HR = ${EARTH_ATMOSPHERE.rayleighScaleHeight.toFixed(1)};
  const float BETA_M = ${(EARTH_ATMOSPHERE.mieScattering * SHELL_TURBIDITY_SCALE).toExponential(4)};
  const float BETA_M_EXT = ${(EARTH_ATMOSPHERE.mieExtinction * SHELL_TURBIDITY_SCALE).toExponential(4)};
  const float HM = ${EARTH_ATMOSPHERE.mieScaleHeight.toFixed(1)};
  const float MIE_G = ${EARTH_ATMOSPHERE.mieG.toFixed(3)};
  const vec3 BETA_O = vec3(${EARTH_ATMOSPHERE.ozoneAbsorption.map(v => v.toExponential(4)).join(', ')});
  const float OZ_C = ${EARTH_ATMOSPHERE.ozoneCentre.toFixed(1)};
  const float OZ_W = ${EARTH_ATMOSPHERE.ozoneHalfWidth.toFixed(1)};
  const float PI = 3.14159265;
  const float TERRAIN_SLACK = ${TERRAIN_SLACK_M.toFixed(1)};
  const float AREA_FEATHER = ${(AREA_FEATHER_DEG * Math.PI / 180).toFixed(6)};
${EARTH_MAP_PARS_FRAGMENT}

  // The ellipsoid becomes a sphere of radius A when the polar axis is stretched
  // by a/b, and the shell is close enough to concentric with it that the same
  // stretch serves. Lengths along a ray stay in real metres because the
  // direction is stretched, not renormalised.
  vec3 toSphere(vec3 v) {
    return v + SQUASH * dot(v, uAxis) * uAxis;
  }

  vec3 extinctionAt(float h) {
    float dR = exp(-h / HR);
    float dM = exp(-h / HM);
    float dO = max(0.0, 1.0 - abs(h - OZ_C) / OZ_W);
    return BETA_R * dR + vec3(BETA_M_EXT * dM) + BETA_O * dO;
  }

  // Optical depth from p to the top of the shell, along unit direction s.
  vec3 sunDepth(vec3 p, vec3 s) {
    float r = length(p);
    float b = dot(p, s);
    float rt = A + TOP;
    float reach = -b + sqrt(max(0.0, b * b - (r - rt) * (r + rt)));
    vec3 tau = vec3(0.0);
    float prev = 0.0;
    for (int i = 0; i < ${SUN_STEPS}; i++) {
      float u = (float(i) + 1.0) / float(${SUN_STEPS});
      float edge = reach * u * u;
      float mid = 0.5 * (prev + edge);
      vec3 q = p + s * mid;
      tau += extinctionAt(max(0.0, length(q) - A)) * (edge - prev);
      prev = edge;
    }
    return tau;
  }

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float stars(vec3 dir) {
    float total = 0.0;
    for (int layer = 0; layer < 2; layer++) {
      float density = layer == 0 ? 90.0 : 200.0;
      vec3 p = dir * density;
      vec3 id = floor(p);
      vec3 f = fract(p) - 0.5;
      float h = hash(id + float(layer) * 31.7);
      vec3 jitter = vec3(hash(id + 3.1), hash(id + 7.9), hash(id + 13.3)) - 0.5;
      float d = length(f - jitter * 0.6);
      float brightness = h > 0.965 ? (h - 0.965) / 0.035 : 0.0;
      total += brightness * smoothstep(0.16, 0.0, d);
    }
    return total;
  }

  // Geodetic latitude and longitude of a point in the stretched frame. The
  // stretch put a / b on the polar component, which is what turns the sphere's
  // parametric latitude back into a geodetic one.
  vec2 latLon(vec3 p) {
    float x = dot(p, uEcefX);
    float y = dot(p, uEcefY);
    float z = dot(p, uAxis);
    return vec2(atan(z * (1.0 + SQUASH), length(vec2(x, y))), atan(y, x));
  }

  // How far inside a baked area a point is: 0 outside every area, rising to
  // 1 at AREA_FEATHER in from the nearest edge. Boxes clip coasts their bake
  // may not have mapped, so their edges are blended rather than drawn.
  float bakedAreaDepth(vec2 ll) {
    float depth = 0.0;
    for (int i = 0; i < ${SHELL_MAX_AREAS}; i++) {
      if (i >= uAreaCount) {
        break;
      }
      vec4 r = uAreas[i];
      float ew = min(ll.y - r.x, r.z - ll.y) * cos(ll.x);
      float ns = min(ll.x - r.y, r.w - ll.x);
      depth = max(depth, smoothstep(0.0, AREA_FEATHER, min(ew, ns)));
    }
    return depth;
  }

  void main() {
    if (uWeight <= 0.0) {
      discard;
    }
    vec2 ndc = gl_FragCoord.xy / uSceneDepthSize * 2.0 - 1.0;
    vec3 viewDir = normalize(vec3(ndc * uTanHalfFov, -1.0));
    vec3 dir = uCamRot * viewDir;

    vec3 o = toSphere(-uCentre);
    vec3 d = toSphere(dir);
    vec3 sun = normalize(toSphere(uSun));
    float a = dot(d, d);
    float b = dot(o, d);
    float rt = A + TOP;
    float cTop = uCamHeight > TOP
      ? (uCamHeight - TOP) * (2.0 * A + uCamHeight + TOP)
      : -(TOP - uCamHeight) * (2.0 * A + uCamHeight + TOP);
    float cGround = uCamHeight * (2.0 * A + uCamHeight);
    float discTop = b * b - a * cTop;
    float discGround = b * b - a * cGround;

    float sceneW = sceneDistance(gl_FragCoord.xy);
    bool terrain = sceneW < uSceneFar * float(${SCENE_DEPTH_SKY_CUT});
    float terrainT = sceneW / max(1e-4, -viewDir.z);

    // Only once the dome has all but gone: stars do not show through a daylit sky.
    vec3 star = vec3(stars(dir)) * smoothstep(0.9, 1.0, uWeight);

    if (discTop <= 0.0) {
      // Misses the shell altogether: only the stars are behind it. A terrain
      // pixel cannot get here, having been hit inside the shell.
      gl_FragColor = vec4(terrain ? vec3(0.0) : star, 0.0);
      return;
    }
    float sq = sqrt(discTop);
    float tNear = max(0.0, (-b - sq) / a);
    float tFar = (-b + sq) / a;
    if (tFar <= 0.0) {
      gl_FragColor = vec4(terrain ? vec3(0.0) : star, 0.0);
      return;
    }

    if (terrain) {
      // The tiles are believed only near the ellipsoid: the coarsest are flat
      // facets whose middles sag hundreds of kilometres under the curve, and
      // from far enough out those are all there is. Once the map has fully
      // taken over, the air is marched to the ellipsoid too.
      vec3 th = o + d * terrainT;
      if (uGlobe >= 1.0 || abs(length(th) - A) > TERRAIN_SLACK) {
        terrain = false;
      }
    }
    bool fallback = false;
    float tEnd = tFar;
    if (terrain) {
      tEnd = min(tEnd, terrainT);
    } else if (discGround > 0.0) {
      float tg = (-b - sqrt(discGround)) / a;
      if (tg > 0.0) {
        tEnd = min(tEnd, tg);
        fallback = true;
      }
    }
    if (tEnd <= tNear) {
      gl_FragColor = vec4(0.0);
      return;
    }
    vec2 hitLatLon = latLon(o + d * tEnd);

    // Closest approach splits the ray in two; each half is sampled densest at
    // the split, which is where the air is thickest for a ray skimming the limb
    // and is the ground end (or the eye end) for the rest.
    float tc = clamp(-b / a, tNear, tEnd);
    float cosTheta = dot(normalize(d), sun);
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
    float g2 = MIE_G * MIE_G;
    float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + cosTheta * cosTheta))
      / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * cosTheta, 1.5));

    vec3 tau = vec3(0.0);
    vec3 radiance = vec3(0.0);
    for (int half_ = 0; half_ < 2; half_++) {
      float span = half_ == 0 ? tc - tNear : tEnd - tc;
      if (span <= 0.0) {
        continue;
      }
      for (int i = 0; i < ${VIEW_STEPS}; i++) {
        // The near half is walked from the eye in, which is from u = 1 down.
        int k = half_ == 0 ? ${VIEW_STEPS - 1} - i : i;
        float u0 = float(k) / float(${VIEW_STEPS});
        float u1 = float(k + 1) / float(${VIEW_STEPS});
        float e0 = u0 * u0 * span;
        float e1 = u1 * u1 * span;
        float t0 = half_ == 0 ? tc - e1 : tc + e0;
        float t1 = half_ == 0 ? tc - e0 : tc + e1;
        float dt = t1 - t0;
        float tm = 0.5 * (t0 + t1);
        vec3 p = o + d * tm;
        float r = length(p);
        float h = max(0.0, r - A);
        vec3 ext = extinctionAt(h);
        vec3 stepTau = ext * dt;
        vec3 view = exp(-(tau + 0.5 * stepTau));

        vec3 up = p / r;
        float bs = dot(p, sun);
        float lit = (bs < 0.0 && bs * bs - (r - A) * (r + A) > 0.0) ? 0.0 : 1.0;
        if (lit > 0.0) {
          vec3 sunT = exp(-sunDepth(p, sun));
          float dR = exp(-h / HR);
          float dM = exp(-h / HM);
          vec3 scatter = BETA_R * dR * (phaseR + 0.25 / (4.0 * PI))
            + vec3(BETA_M * dM * phaseM);
          radiance += view * sunT * scatter * dt;
        }
        tau += stepTau;
      }
    }

    vec3 transmittance = exp(-tau);
    vec3 emission = radiance;
    float alpha = 1.0;
    // Outside every baked area the tiles are sea-level fill padding the
    // ancestors out to whole quadrants: real only where the map says sea.
    float fill = terrain ? 1.0 - bakedAreaDepth(hitLatLon) : 0.0;
    // How much of the globe map is drawn: over baked terrain as the camera
    // climbs, on the bare ellipsoid as the shell itself fades in, never on
    // open sky. The map is opaque: once it is in, nothing under it shows.
    // No scene there at all - the bare ellipsoid, or a crack between tiles -
    // takes the map almost as soon as the shell is on, as nothing else could
    // show through but the sky behind the ground.
    float globe = fallback ? max(uGlobe, min(1.0, uWeight * 10.0)) : (terrain ? uGlobe : 0.0);
    vec4 globeColour = vec4(0.0);
    bool openSky = false;
    float mapWater = 0.0;

    if (terrain) {
      // Daylight on the far side of the terminator: the scene was lit for one
      // sun direction all over, so the shell dims it by the local sun height.
      vec3 hit = o + d * tEnd;
      float mu = dot(normalize(hit), sun);
      float day = mix(0.06, 1.0, smoothstep(-0.08, 0.18, mu));
      float shell = mix(1.0, day, uWeight);
      float mean = dot(transmittance, vec3(1.0 / 3.0)) * shell;
      alpha = 1.0 - mean;
    } else if (!fallback) {
      // Open sky over the limb: the stars shine through what air is in front.
      emission += star * transmittance;
      // The shell's own sky takes the place of the dome (crossfaded by
      // uSkyWeight) rather than lying over it, so the dome has nothing left to
      // show when it is switched off.
      alpha = 1.0;
      openSky = true;
    }
    vec3 toned = 1.0 - exp(-emission * uExposure * (openSky ? uSkyGain : 1.0));
    if (globe > 0.0 || terrain) {
      vec3 hit = o + d * tEnd;
      float mu = dot(normalize(hit), sun);
      vec3 sunT = exp(-sunDepth(hit, sun));
      float direct = max(0.0, mu) * (1.0 / PI);
      // Sun glint: the ocean is a mirror, so the disc's reflection is the one
      // bright thing on it. Tight lobe on the half vector.
      vec3 toEye = normalize(-d);
      vec3 nrm = normalize(hit);
      float glint = pow(max(dot(nrm, normalize(sun + toEye)), 0.0), 4000.0) * 60.0;

      // The pixel's footprint on the ground picks the map's filtering.
      float pixel = 2.0 * uTanHalfFov.y / uSceneDepthSize.y;
      float incidence = max(abs(dot(nrm, toEye)), 0.02);
      vec3 albedo = earthAlbedo(hitLatLon, tEnd * pixel / sqrt(incidence));
      // The map's oceans are near black with a blue cast; they take the
      // ocean radiance the rest of the planet is drawn with, and the glint.
      // Open ocean is so dark that JPEG noise swamps the blue cast, so near
      // black counts as water too; the darkest forest is several times brighter.
      float water = max(smoothstep(1.6, 3.0, albedo.b / max(albedo.g, 1e-4)),
        smoothstep(0.006, 0.002, max(albedo.r, albedo.g)));
      vec3 surface = mix(albedo, uSurface, water);
      mapWater = water;
      vec3 lit = (transmittance * (surface * (sunT * direct * 3.0 + 0.02) + sunT * glint * water * step(0.0, mu)));
      globeColour = vec4(1.0 - exp(-(emission + lit) * uExposure), 1.0);
      // Over terrain the map's sea comes in on the later schedule, inside an
      // area or out: the fill is the same water as an area's sea, so an
      // area's edge does not show as a step in it. The map's land comes in
      // with the shell over baked land - softly, as the bake is the sharper
      // picture - but at once over fill, which has nothing to show there.
      if (terrain) {
        float land = mix(uWeight, min(1.0, uWeight * 10.0), fill);
        globe = max(uGlobe, land * (1.0 - water));
      }
    }
    if (uMapMode > 0.5) {
      // Premultiplied: the map where nothing was baked, see-through elsewhere.
      float g = fallback ? 1.0 : (terrain ? fill : 0.0);
      gl_FragColor = mix(globeColour, vec4(uMapWater, 1.0), mapWater) * g;
      return;
    }
    // Premultiplied, so drawing the globe over the faded air is a plain mix.
    float weight = openSky ? uSkyWeight : uWeight;
    gl_FragColor = mix(vec4(toned * weight, alpha * weight), globeColour, globe);

    // The scene target holds linear colour in 8 bits, so the dark end of the
    // sky - a few 1/255 steps, each a big jump once encoded to sRGB - comes
    // out as coloured bands. A triangular dither of one step breaks them up.
    // It fades out towards zero so black space stays black.
    vec2 fc = gl_FragCoord.xy;
    float n = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))))
      + fract(52.9829189 * fract(dot(fc + vec2(47.0, 17.0), vec2(0.06711056, 0.00583715)))) - 1.0;
    vec3 c = gl_FragColor.rgb;
    gl_FragColor.rgb = max(c + n * min(c * 255.0, vec3(1.0)) / 255.0, 0.0);
  }
`;

/** Written once per frame by the game; shared by reference with the material. */
export const ATMOSPHERE_SHELL_UNIFORMS = {
    uCamRot: { value: new THREE.Matrix3() },
    uTanHalfFov: { value: new THREE.Vector2(1, 1) },
    uCentre: { value: new THREE.Vector3() },
    uAxis: { value: new THREE.Vector3(0, 1, 0) },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uCamHeight: { value: 0 },
    uWeight: { value: 0 },
    uSkyWeight: { value: 0 },
    uSkyGain: { value: 1 },
    uExposure: { value: 4 },
    uSurface: { value: new THREE.Vector3(0.03, 0.09, 0.22) },
    uEcefX: { value: new THREE.Vector3(1, 0, 0) },
    uEcefY: { value: new THREE.Vector3(0, 0, -1) },
    uGlobe: { value: 0 },
    uMapMode: { value: 0 },
    uMapWater: { value: new THREE.Color() },
    uAreas: { value: Array.from({ length: SHELL_MAX_AREAS }, () => new THREE.Vector4()) },
    uAreaCount: { value: 0 },
};


export class AtmosphereShellModelLibBuilder implements ModelLibBuilder {

    constructor(public type: string) { }

    build(_materials: unknown): Model {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(
            new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        const material = new THREE.ShaderMaterial({
            vertexShader: VERTEX_PROGRAM,
            fragmentShader: FRAGMENT_PROGRAM,
            uniforms: { ...ATMOSPHERE_SHELL_UNIFORMS, ...EARTH_MAP_UNIFORMS, ...SCENE_DEPTH_UNIFORMS },
            depthTest: false,
            depthWrite: false,
            transparent: true,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            // Premultiplied: the colour already carries the inscatter and the
            // alpha is what the scene loses to the air in front of it.
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            side: THREE.DoubleSide,
            userData: {},
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'atmosphereShell';
        mesh.frustumCulled = false;
        mesh.renderOrder = 0;
        return {
            lod: [{ flats: [], volumes: [mesh] }],
            animations: [],
            maxSize: 2,
            center: new THREE.Vector3(),
        };
    }
}
