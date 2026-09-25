import { AiPilotModels } from '../state/gameDefs';
import { AceAiPilot } from './ace/aceAiPilot';
import { AggressiveAiPilot } from './aggressive/aggressiveAiPilot';
import { AiPilot, AiPilotOptions } from './aiPilot';
import { AiPilotController } from './aiPilotController';
import { PilotableAircraft } from './aircraftControls';
import { ShawAiPilot } from './shaw/shawAiPilot';
import { WorldQuery } from './worldQuery';

/**
 * Build the in-worker AI pilot for the requested model. Omitting
 * {@link AiPilotOptions.model} (or CLASSIC) preserves prior behaviour.
 */
export function createAiPilot(
    aircraft: PilotableAircraft,
    world: WorldQuery,
    options: AiPilotOptions = {},
): AiPilotController {
    const model = options.model ?? AiPilotModels.CLASSIC;
    if (model === AiPilotModels.SHAW) {
        return new ShawAiPilot(aircraft, world, options);
    }
    if (model === AiPilotModels.AGGRESSIVE) {
        return new AggressiveAiPilot(aircraft, world, options);
    }
    if (model === AiPilotModels.ACE) {
        return new AceAiPilot(aircraft, world, options);
    }
    return new AiPilot(aircraft, world, options);
}
