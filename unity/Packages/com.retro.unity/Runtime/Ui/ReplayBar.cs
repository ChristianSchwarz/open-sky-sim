using System;
using System.Collections.Generic;
using Retro.Game;
using UnityEngine;
using UnityEngine.UIElements;

namespace Retro.Unity
{
    /// <summary>
    /// The replay bar (game.ts buildReplayUi / updateReplayHud): along the
    /// bottom of the screen while a replay plays, a scrubber over the whole
    /// recording, then restart, back 5 s, play/pause, forward 5 s, the time,
    /// the speed (click faster, Shift-click slower), the views and Exit. No
    /// control takes keyboard focus, so Space still pauses.
    /// </summary>
    public sealed class ReplayBar : MonoBehaviour
    {
        public PlayerFlight flight;

        private static readonly Color ButtonBack = new Color(1, 1, 1, 0.12f);
        private static readonly Color ButtonActive = new Color(80 / 255f, 160 / 255f, 1, 0.6f);
        private static readonly Color ButtonLine = new Color(1, 1, 1, 0.3f);

        private VisualElement bar;
        private Slider seek;
        private Button play, speed;
        private Label time;
        private readonly List<(FlightView View, Button Button)> views = new List<(FlightView, Button)>();
        private bool scrubbing;

        private void Start()
        {
            var document = gameObject.AddComponent<UIDocument>();
            document.panelSettings = Resources.Load<PanelSettings>("RetroPanelSettings");
            document.sortingOrder = 150;
            VisualElement root = document.rootVisualElement;
            root.pickingMode = PickingMode.Ignore;
            // The scrubber lets go wherever the pointer comes up.
            root.RegisterCallback<PointerUpEvent>(_ => scrubbing = false, TrickleDown.TrickleDown);

            bar = new VisualElement();
            MenuDialog.Style(bar, s =>
            {
                s.position = Position.Absolute;
                s.left = s.right = s.bottom = 0;
                s.flexDirection = FlexDirection.Column;
                s.paddingLeft = s.paddingRight = 16;
                s.paddingTop = 8;
                s.paddingBottom = 12;
                // The web fades in from transparent; UI Toolkit has no gradient, so a flat shade.
                s.backgroundColor = new Color(0, 0, 0, 0.6f);
                s.display = DisplayStyle.None;
            });
            root.Add(bar);

            seek = new Slider(0, 1000) { focusable = false };
            seek.style.marginBottom = 6;
            seek.RegisterCallback<PointerDownEvent>(_ => scrubbing = true, TrickleDown.TrickleDown);
            seek.RegisterCallback<PointerCaptureOutEvent>(_ => scrubbing = false);
            seek.RegisterValueChangedCallback(e =>
            {
                FlightRecorder rec = flight.Recorder;
                flight.ReplayPlayer.Time = rec.StartTime + e.newValue / 1000 * rec.Duration;
            });
            bar.Add(seek);

            var row = new VisualElement();
            MenuDialog.Style(row, s =>
            {
                s.flexDirection = FlexDirection.Row;
                s.alignItems = Align.Center;
                s.flexWrap = Wrap.Wrap;
            });
            bar.Add(row);

            row.Add(MakeButton("|<", "Restart (Home)", () => flight.ReplayPlayer.Start()));
            row.Add(MakeButton("-5s", "Back 5 s (Left or ,)", () => flight.ReplayPlayer.Seek(-5)));
            play = MakeButton("Pause", "Play / pause (Space)", () => flight.ReplayPlayer.Paused = !flight.ReplayPlayer.Paused);
            row.Add(play);
            row.Add(MakeButton("+5s", "Forward 5 s (Right or .)", () => flight.ReplayPlayer.Seek(5)));
            time = MenuDialog.Label("", 13, Color.white);
            MenuDialog.Style(time, s =>
            {
                s.minWidth = 90;
                s.marginLeft = s.marginRight = 4;
                s.whiteSpace = WhiteSpace.NoWrap;
            });
            row.Add(time);
            speed = MakeButton("1x", "Playback speed (click: faster, Shift-click: slower)", null);
            speed.RegisterCallback<ClickEvent>(e =>
            {
                if (e.shiftKey) flight.ReplayPlayer.ChangeSpeed(-1);
                else flight.ReplayPlayer.CycleSpeed();
            });
            row.Add(speed);
            var spacer = new VisualElement();
            spacer.style.flexGrow = 1;
            row.Add(spacer);
            AddView(row, "Cockpit", FlightView.Cockpit, "Cockpit (F1)");
            AddView(row, "Behind", FlightView.ChaseBack, "Chase from behind (F2)");
            AddView(row, "Front", FlightView.ChaseFront, "From the front");
            AddView(row, "Left", FlightView.Left, "Left side");
            AddView(row, "Right", FlightView.Right, "Right side");
            AddView(row, "Free", FlightView.Free, "Free camera");
            AddView(row, "Tower", FlightView.CarrierStern, "Over-the-stern view (F3)");
            row.Add(MakeButton("Exit", "Leave replay (F4 / Esc)", () => flight.StopReplay()));
        }

        private void AddView(VisualElement row, string label, FlightView v, string tip)
        {
            Button b = MakeButton(label, tip, () => flight.SetReplayView(v));
            views.Add((v, b));
            row.Add(b);
        }

        private static Button MakeButton(string label, string tip, Action click)
        {
            var b = click != null ? new Button(click) : new Button();
            b.text = label;
            b.tooltip = tip;
            b.focusable = false;
            MenuDialog.Style(b, s =>
            {
                s.backgroundColor = ButtonBack;
                s.color = Color.white;
                s.fontSize = 13;
                s.paddingLeft = s.paddingRight = 10;
                s.paddingTop = s.paddingBottom = 4;
                s.marginLeft = 0;
                s.marginRight = 8;
                s.borderTopWidth = s.borderBottomWidth = s.borderLeftWidth = s.borderRightWidth = 1;
                s.borderTopColor = s.borderBottomColor = s.borderLeftColor = s.borderRightColor = ButtonLine;
                MenuDialog.Round(s, 4);
            });
            return b;
        }

        private void Update()
        {
            if (bar == null || flight == null) return;
            bool shown = flight.Replaying;
            bar.style.display = shown ? DisplayStyle.Flex : DisplayStyle.None;
            if (!shown) return;
            ReplayPlayer r = flight.ReplayPlayer;
            FlightRecorder rec = flight.Recorder;
            play.text = r.Paused ? "Play" : "Pause";
            time.text = $"{Clock(r.Time - rec.StartTime)} / {Clock(rec.Duration)}";
            speed.text = $"{r.Speed}x";
            if (!scrubbing) seek.SetValueWithoutNotify((float)Math.Round(r.Fraction * 1000));
            foreach ((FlightView v, Button b) in views)
            {
                b.style.backgroundColor = v == flight.flightView ? ButtonActive : ButtonBack;
            }
        }

        private static string Clock(double s) => $"{Math.Floor(s / 60)}:{Math.Floor(s % 60):00}";
    }
}
