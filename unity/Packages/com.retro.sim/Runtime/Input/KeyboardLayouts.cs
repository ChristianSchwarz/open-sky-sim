using System.Collections.Generic;

namespace Retro.Sim
{
    /// <summary>Shared keyboard layout definitions (port of input/keyboardLayouts.ts).</summary>
    public enum KeyboardControlAction
    {
        PITCH_POS,
        PITCH_NEG,
        ROLL_POS,
        ROLL_NEG,
        YAW_POS,
        YAW_NEG,
        THROTTLE_POS,
        THROTTLE_NEG,
    }

    public enum KeyboardControlLayoutId
    {
        QWERTY,
        QWERTZ,
        AZERTY,
        DVORAK,
        ARROWS,
    }

    /// <summary>How pitch keys map to stick deflection.</summary>
    public enum KeyboardPitchStickMode
    {
        /// <summary>Arrows layout: latched stepped stick; letter layouts: full deflection while held.</summary>
        LAYOUT_DEFAULT,
        /// <summary>Full deflection while a pitch key is held, neutral on release, whatever the layout.</summary>
        HOLD,
    }

    /// <summary>A layout: one key (KeyboardEvent.key, lower case) per action, in action order.</summary>
    public sealed class KeyboardControlLayout
    {
        private readonly string[] keys;

        public KeyboardControlLayout(string pitchPos, string pitchNeg, string rollPos, string rollNeg,
            string yawPos, string yawNeg, string throttlePos, string throttleNeg)
        {
            keys = new[] { pitchPos, pitchNeg, rollPos, rollNeg, yawPos, yawNeg, throttlePos, throttleNeg };
        }

        public string this[KeyboardControlAction action] => keys[(int)action];

        /// <summary>Object.values(layout): the keys in action order.</summary>
        public IReadOnlyList<string> Values => keys;
    }

    public static class KeyboardLayouts
    {
        private static readonly KeyboardControlLayout Qwerty = new KeyboardControlLayout("s", "w", "d", "a", "e", "q", "z", "x");
        private static readonly KeyboardControlLayout Qwertz = new KeyboardControlLayout("s", "w", "d", "a", "e", "q", "y", "x");
        private static readonly KeyboardControlLayout Azerty = new KeyboardControlLayout("s", "z", "d", "q", "e", "a", "w", "x");
        private static readonly KeyboardControlLayout Dvorak = new KeyboardControlLayout("o", ",", "e", "a", ".", "'", "q", "j");
        private static readonly KeyboardControlLayout Arrows = new KeyboardControlLayout(
            "arrowdown", "arrowup", "arrowright", "arrowleft", "x", "y", "numpadadd", "numpadsubtract");

        public static readonly IReadOnlyDictionary<KeyboardControlLayoutId, KeyboardControlLayout> KeyboardControlLayouts =
            new Dictionary<KeyboardControlLayoutId, KeyboardControlLayout>
            {
                [KeyboardControlLayoutId.QWERTY] = Qwerty,
                [KeyboardControlLayoutId.QWERTZ] = Qwertz,
                [KeyboardControlLayoutId.AZERTY] = Azerty,
                [KeyboardControlLayoutId.DVORAK] = Dvorak,
                [KeyboardControlLayoutId.ARROWS] = Arrows,
            };

        public static KeyboardControlLayout GetKeyboardLayout(KeyboardControlLayoutId layoutId)
        {
            return KeyboardControlLayouts.TryGetValue(layoutId, out KeyboardControlLayout l) ? l : Qwerty;
        }
    }
}
