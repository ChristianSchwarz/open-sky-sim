import { AudioSystem } from './audio/audioSystem';
import { ConfigService } from './config/configService';
import { PaletteCategory } from './config/palettes/palette';
import { HDNoonPalette } from './config/palettes/hd-noon';
import { DisplayShading, FogQuality, TechProfile } from './config/profiles/profile';
import { HDProfile } from './config/profiles/hd';
import { loadSettings } from './config/settingsStorage';
import { Kernel } from './core/kernel';
import { HD_FPS_CAP, H_RES, V_RES } from './defs';
import { JoystickControlDevice } from './input/devices/joystickControlDevice';
import { KeyboardControlDevice } from './input/devices/keyboardControlDevice';
import { hideBootProgress, setBootProgress } from './osd/bootProgress';
import { setupOSD } from './osd/osdPanel';
import { CombatSimClient } from './physics/sim/combatSimClient';
import { SimProxyFlightModel } from './physics/model/simProxyFlightModel';
import { PLAYER_SIM_ID } from './physics/sim/simIds';
import { Renderer } from './render/renderer';
import { SceneMaterialManager } from './scene/materials/materials';
import { setSunTime } from './scene/materials/shaders/sun';
import { CIRRUS_STREAK_SHAPES, CirrusModelLibBuilder } from './scene/models/lib/cirrusModelBuilder';
import { CLOUD_PUFF_SHAPES, CloudModelLibBuilder } from './scene/models/lib/cloudModelBuilder';
import { FieldModelLibBuilder, FieldModelType } from './scene/models/lib/fieldModelBuilder';
import { HILL_MODEL_BASE_RADIUS, HILL_MODEL_HEIGHT, MOUNTAIN_MODEL_BASE_RADIUS, MOUNTAIN_MODEL_HEIGHT, MountainModelLibBuilder } from './scene/models/lib/mountainModelBuilder';
import { ArrestorCablesModelLibBuilder } from './scene/models/lib/arrestorCablesModelBuilder';
import { TailhookModelLibBuilder } from './scene/models/lib/tailhookModelBuilder';
import { SkiJumpModelLibBuilder } from './scene/models/lib/skiJumpModelBuilder';
import { SkyDomeModelLibBuilder } from './scene/models/lib/skyDomeModelBuilder';
import { SunModelLibBuilder } from './scene/models/lib/sunModelBuilder';
import { TracerModelLibBuilder } from './scene/models/lib/tracerModelBuilder';
import { ModelManager } from './scene/models/models';
import { Game, GameRenderTask, GameUpdateTask } from './state/game';
import { FlightModels, TechProfiles } from './state/gameDefs';
import { DETAIL_DISTANCE_OFF } from './terrain/lod';
async function setup(): Promise<[Kernel, ConfigService, KeyboardControlDevice, JoystickControlDevice, Game, AudioSystem]> {
    const settings = loadSettings();
    // Single authoritative combat sim worker. The player's FM2/DEBUG models are
    // render-side proxies bound to it (id PLAYER_SIM_ID). AI opponents register
    // with the same client (see Game.setupCombat).
    const combatSim = new CombatSimClient();
    const config = new ConfigService(
        { [TechProfiles.HD]: HDProfile },
        {
            [FlightModels.FM2]: new SimProxyFlightModel(combatSim, PLAYER_SIM_ID, 'fm2'),
            [FlightModels.FM3]: new SimProxyFlightModel(combatSim, PLAYER_SIM_ID, 'fm3'),
            [FlightModels.DEBUG]: new SimProxyFlightModel(combatSim, PLAYER_SIM_ID, 'debug'),
        },
        settings.techProfile,
        settings.flightModel,
        settings.aiPilotModel,
        settings.daytime,
        settings.terrainColour,
        settings.terrainDetailDistanceM ?? DETAIL_DISTANCE_OFF,
        settings.terrainShading,
        settings.landuseBlend,
        settings.landuseReach,
        settings.terrainTriangleBudget,
        settings.landuseRevealPx,
        settings.farTileTextures,
    );
    config.flightModels.getActive().activate();
    // Place the sun before the first material is built, so the shaded ramp and
    // the planform silhouettes start on the persisted time of day.
    setSunTime(config.daytime.getActive());
    const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
    const renderer = new Renderer(materials, H_RES, V_RES, HDNoonPalette);
    const models = new ModelManager(materials, [
        new SkyDomeModelLibBuilder('skyDome'),
        new SunModelLibBuilder('sun'),
        new CloudModelLibBuilder('cloudNone', []),
        new CloudModelLibBuilder('cloudSmall', CLOUD_PUFF_SHAPES.small),
        new CloudModelLibBuilder('cloudMedium', CLOUD_PUFF_SHAPES.medium),
        new CloudModelLibBuilder('cloudLarge', CLOUD_PUFF_SHAPES.large),
        new CirrusModelLibBuilder('cirrusNone', []),
        new CirrusModelLibBuilder('cirrusThin', CIRRUS_STREAK_SHAPES.thin),
        new CirrusModelLibBuilder('cirrusWide', CIRRUS_STREAK_SHAPES.wide),
        new FieldModelLibBuilder('pavement', FieldModelType.SQUARE, PaletteCategory.SCENERY_ROAD_SECONDARY),
        new MountainModelLibBuilder('hill', HILL_MODEL_BASE_RADIUS, HILL_MODEL_HEIGHT, PaletteCategory.SCENERY_MOUNTAIN_GRASS, false, false),
        new MountainModelLibBuilder('mountain', MOUNTAIN_MODEL_BASE_RADIUS, MOUNTAIN_MODEL_HEIGHT, PaletteCategory.SCENERY_MOUNTAIN_GRASS, false, false),
        new SkiJumpModelLibBuilder('skiJump'),
        new ArrestorCablesModelLibBuilder('arrestorCables'),
        new TailhookModelLibBuilder('tailhook'),
        new TracerModelLibBuilder('tracer'),
    ]);
    const audio = new AudioSystem();
    const game = new Game(config, models, materials, renderer, audio, combatSim);
    // Apply persisted settings after Game registers change listeners.
    config.techProfiles.notifyActive();
    config.flightModels.notifyActive();
    config.daytime.notifyActive();
    await game.setup();

    const keyboardInput = new KeyboardControlDevice(
        combatSim,
        game.getPlayer(),
        PLAYER_SIM_ID,
        () => config.flightModels.getActive() instanceof SimProxyFlightModel,
    );
    keyboardInput.setKeyboardLayout(settings.keyboardLayout);
    const joystickInput = new JoystickControlDevice(
        combatSim,
        game.getPlayer(),
        PLAYER_SIM_ID,
        () => config.flightModels.getActive() instanceof SimProxyFlightModel,
    );

    const kernel = new Kernel();
    const combatSimUsesShared = combatSim.usesSharedState();
    const targetFpsFor = (_profile: TechProfile): number | undefined => {
        // Without SharedArrayBuffer isolation, rAF can starve worker onmessage —
        // soft-cap so the event loop can drain replies. With SAB pose mirror, uncap.
        return combatSimUsesShared ? undefined : HD_FPS_CAP;
    };
    kernel.setTargetFPS(targetFpsFor(config.techProfiles.getActive()));
    kernel.addUpdateTask(materials);
    kernel.addUpdateTask(keyboardInput);
    kernel.addUpdateTask(joystickInput);
    kernel.addUpdateTask(new GameUpdateTask(game));
    kernel.addRenderTask(new GameRenderTask(game));

    config.techProfiles.addChangeListener(profile => kernel.setTargetFPS(targetFpsFor(profile)));

    return [kernel, config, keyboardInput, joystickInput, game, audio];
}

window.addEventListener("load", () => {
    setBootProgress(0, 'Loading...');
    void setup().then(([kernel, config, keyboardInput, joystickInput, game, audio]) => {
        kernel.start();
        setupOSD(config, keyboardInput, joystickInput, audio);
        hideBootProgress();
    }).catch((err) => {
        setBootProgress(100, `Load failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error(err);
    });
});
