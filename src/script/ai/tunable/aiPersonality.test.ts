import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    AI_PERSONALITY_KEYS, AI_PERSONALITY_PRESETS, aiPersonalityPreset, clampAiPersonality, defaultAiPersonality,
    personalityTuning,
} from './aiPersonality';

describe('AiPersonality', () => {
    it('fills missing or bad fields with the default and clamps the rest', () => {
        const p = clampAiPersonality({ aggression: 3, skill: -1, gLimit: 20, defensiveness: 'x' });
        const d = defaultAiPersonality();
        assert.equal(p.aggression, 1);
        assert.equal(p.skill, 0);
        assert.equal(p.gLimit, 9);
        assert.equal(p.defensiveness, d.defensiveness);
        assert.deepEqual(clampAiPersonality(undefined), d);
    });

    it('every preset is valid as it stands', () => {
        for (const preset of AI_PERSONALITY_PRESETS) {
            assert.deepEqual(clampAiPersonality(preset.personality), preset.personality, preset.id);
            assert.deepEqual(Object.keys(preset.personality).sort(), [...AI_PERSONALITY_KEYS].sort(), preset.id);
        }
        assert.equal(aiPersonalityPreset('nope'), undefined);
    });

    it('skill buys reaction time, aim and g', () => {
        const rookie = personalityTuning({ ...defaultAiPersonality(), skill: 0 });
        const ace = personalityTuning({ ...defaultAiPersonality(), skill: 1 });
        assert.ok(ace.reactTime < rookie.reactTime);
        assert.ok(ace.aimNoise < rookie.aimNoise);
        assert.equal(ace.aimNoise, 0);
        assert.ok(ace.gCap > rookie.gCap);
        assert.ok(ace.combatSpeed > rookie.combatSpeed);
        assert.ok(ace.headOnFireRange > rookie.headOnFireRange);
        assert.ok(ace.headOnSetupRange > rookie.headOnSetupRange);
        assert.equal(ace.reversal && ace.gunPassBrakes, true);
        assert.equal(rookie.reversal || rookie.gunPassBrakes, false);
        assert.equal(rookie.noseRaceMargin, Infinity);
    });

    it('aggression decides the head-on pass and how long it fights on low energy', () => {
        const timid = personalityTuning({ ...defaultAiPersonality(), aggression: 0 });
        const berserk = personalityTuning({ ...defaultAiPersonality(), aggression: 1 });
        assert.equal(timid.headOnPass, false);
        assert.equal(berserk.headOnPass, true);
        assert.equal(berserk.extendDeficit, Infinity);
        assert.ok(timid.extendDeficit < 500);
    });

    it('defensiveness widens what counts as a threat', () => {
        const low = personalityTuning({ ...defaultAiPersonality(), defensiveness: 0 });
        const high = personalityTuning({ ...defaultAiPersonality(), defensiveness: 1 });
        assert.ok(high.threatCone > low.threatCone);
        assert.ok(high.threatAta < low.threatAta);
        assert.ok(high.threatRange > low.threatRange);
        assert.equal(low.jinkPeriod, Infinity);
        assert.ok(Number.isFinite(high.jinkPeriod));
    });

    it('gun discipline tightens the trigger', () => {
        const spray = personalityTuning({ ...defaultAiPersonality(), gunDiscipline: 0 });
        const sniper = personalityTuning({ ...defaultAiPersonality(), gunDiscipline: 1 });
        assert.ok(sniper.missMult < spray.missMult);
        assert.ok(sniper.gunRangeMult < spray.gunRangeMult);
    });
});
