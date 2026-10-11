using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Game;
using UnityEngine;
using UnityEngine.UIElements;

namespace Retro.Unity
{
    /// <summary>
    /// One tab of the settings dialog built from the ported
    /// <see cref="SettingsDialogModel"/> (settingsDialog.ts's template): each
    /// section's heading, help and note, then a widget per control - sliders
    /// with their readouts, drop-downs, radio groups, switches, buttons, key
    /// lists, data credits. Widgets are refreshed in place when the model
    /// says something changed, so a slider keeps its drag.
    /// </summary>
    public sealed class SettingsTabView
    {
        private readonly List<Action> refresh = new List<Action>();

        public VisualElement Root { get; } = new VisualElement();

        public SettingsTabView(SettingsTabModel tab)
        {
            foreach (SettingsSection section in tab.Sections) Root.Add(Section(section));
            Refresh();
        }

        /// <summary>Re-read every value, readout, visibility and enablement.</summary>
        public void Refresh()
        {
            foreach (Action a in refresh) a();
        }

        private VisualElement Section(SettingsSection s)
        {
            var box = new VisualElement();
            box.style.marginBottom = 18;
            if (s.Title != null)
            {
                Label title = MenuDialog.Label(s.Title, 15, MenuDialog.Text);
                title.style.unityFontStyleAndWeight = FontStyle.Bold;
                box.Add(title);
            }
            if (s.Help != null) box.Add(MenuDialog.Label(s.Help, 12, MenuDialog.Muted));
            if (s.Note != null) box.Add(MenuDialog.Label(s.Note, 11, MenuDialog.Muted));
            foreach (SettingsControl c in s.Controls)
            {
                VisualElement w = Control(c);
                if (w == null) continue;
                w.style.marginTop = 6;
                box.Add(w);
                refresh.Add(() =>
                {
                    w.style.display = c.Visible() ? DisplayStyle.Flex : DisplayStyle.None;
                    w.SetEnabled(c.Enabled());
                });
            }
            refresh.Add(() => box.style.display = s.Visible() ? DisplayStyle.Flex : DisplayStyle.None);
            return box;
        }

        private VisualElement Control(SettingsControl c) => c switch
        {
            SliderControl s => Slider(s),
            ChoiceControl ch when ch.Kind == SettingsControlKind.Select => Select(ch),
            ChoiceControl ch => Radio(ch),
            ToggleControl t => Toggle(t),
            ButtonControl b => MenuDialog.OutlineButton(b.Label ?? "", () => b.Click()),
            ListControl l => List(l),
            KeysControl k => Keys(k),
            CreditsControl cr => Credits(cr.Group),
            _ => null,
        };

        private VisualElement Slider(SliderControl s)
        {
            var row = new VisualElement();
            row.style.flexDirection = FlexDirection.Row;
            row.style.alignItems = Align.Center;
            if (s.Label != null) row.Add(Fixed(MenuDialog.Label(s.Label, 13, MenuDialog.Text), 110));
            if (s.MinLabel != null) row.Add(MenuDialog.Label(s.MinLabel, 11, MenuDialog.Muted));
            var slider = new Slider((float)s.Range.Min, (float)s.Range.Max);
            slider.style.flexGrow = 1;
            slider.style.marginLeft = slider.style.marginRight = 8;
            var readout = MenuDialog.Label("", 13, MenuDialog.Text);
            readout.style.minWidth = 64;
            readout.style.unityTextAlign = TextAnchor.MiddleRight;
            slider.RegisterValueChangedCallback(e =>
            {
                // The input element steps; so does the web slider.
                double v = s.Range.Step > 0 ? s.Range.Min + Math.Round((e.newValue - s.Range.Min) / s.Range.Step) * s.Range.Step : e.newValue;
                s.Set(v);
                readout.text = s.Readout();
            });
            row.Add(slider);
            if (s.MaxLabel != null) row.Add(MenuDialog.Label(s.MaxLabel, 11, MenuDialog.Muted));
            row.Add(readout);
            refresh.Add(() =>
            {
                slider.SetValueWithoutNotify((float)s.Value());
                readout.text = s.Readout();
            });
            return row;
        }

        private VisualElement Select(ChoiceControl c)
        {
            var field = new DropdownField(c.Label ?? "");
            field.style.maxWidth = 360;
            Dictionary<string, string> byLabel = null;
            field.RegisterValueChangedCallback(e =>
            {
                if (byLabel != null && byLabel.TryGetValue(e.newValue, out string v)) c.Set(v);
            });
            refresh.Add(() =>
            {
                IReadOnlyList<SettingsOption> options = c.Options();
                byLabel = options.ToDictionary(o => o.Label, o => o.Value);
                field.choices = options.Select(o => o.Label).ToList();
                string current = c.Value();
                SettingsOption sel = options.FirstOrDefault(o => o.Value == current);
                field.SetValueWithoutNotify(sel?.Label ?? "");
            });
            return field;
        }

        private VisualElement Radio(ChoiceControl c)
        {
            var box = new VisualElement();
            if (c.Label != null) box.Add(MenuDialog.Label(c.Label, 13, MenuDialog.Text));
            var grid = new VisualElement();
            grid.style.flexDirection = FlexDirection.Row;
            grid.style.flexWrap = Wrap.Wrap;
            box.Add(grid);
            int columns = Math.Max(1, c.Columns);
            refresh.Add(() =>
            {
                grid.Clear();
                string current = c.Value();
                foreach (SettingsOption o in c.Options())
                {
                    string value = o.Value;
                    bool on = value == current;
                    var b = new Button(() => c.Set(value)) { text = (on ? "◉  " : "○  ") + o.Label };
                    MenuDialog.Style(b, st =>
                    {
                        st.width = Length.Percent(100f / columns - 1);
                        st.backgroundColor = Color.clear;
                        st.color = on ? MenuDialog.Accent : MenuDialog.Text;
                        st.unityTextAlign = TextAnchor.MiddleLeft;
                        st.fontSize = 13;
                        st.height = 28;
                        MenuDialog.NoBorder(st);
                    });
                    grid.Add(b);
                }
            });
            return box;
        }

        private VisualElement Toggle(ToggleControl t)
        {
            var toggle = new Toggle(t.Label ?? "");
            toggle.style.color = MenuDialog.Text;
            toggle.RegisterValueChangedCallback(e => t.Set(e.newValue));
            refresh.Add(() => toggle.SetValueWithoutNotify(t.Value()));
            return toggle;
        }

        private VisualElement List(ListControl l)
        {
            var list = new ScrollView(ScrollViewMode.Vertical);
            list.style.height = 120;
            refresh.Add(() =>
            {
                list.Clear();
                IReadOnlyList<string> items = l.Items();
                int selected = l.Selected();
                for (int i = 0; i < items.Count; i++)
                {
                    int index = i;
                    var b = new Button(() => l.Select(index)) { text = (index == selected ? "◉  " : "○  ") + items[i] };
                    MenuDialog.Style(b, st =>
                    {
                        st.backgroundColor = Color.clear;
                        st.color = index == selected ? MenuDialog.Accent : MenuDialog.Text;
                        st.unityTextAlign = TextAnchor.MiddleLeft;
                        st.height = 28;
                        MenuDialog.NoBorder(st);
                    });
                    list.Add(b);
                }
            });
            return list;
        }

        private VisualElement Keys(KeysControl k)
        {
            var box = new VisualElement();
            refresh.Add(() =>
            {
                box.Clear();
                string caption = k.Caption();
                if (caption != null) box.Add(MenuDialog.Label(caption, 12, MenuDialog.Muted));
                foreach (HelpEntry e in k.Entries())
                {
                    var row = new VisualElement();
                    row.style.flexDirection = FlexDirection.Row;
                    var caps = new VisualElement();
                    caps.style.flexDirection = FlexDirection.Row;
                    caps.style.width = 190;
                    foreach (string key in e.Keys)
                    {
                        Label cap = MenuDialog.Label(key, 12, MenuDialog.Text);
                        MenuDialog.Style(cap, st =>
                        {
                            st.backgroundColor = MenuDialog.Field;
                            st.paddingLeft = st.paddingRight = 6;
                            st.marginRight = 4;
                            MenuDialog.Round(st, 4);
                        });
                        caps.Add(cap);
                    }
                    row.Add(caps);
                    row.Add(MenuDialog.Label(e.Action, 12, MenuDialog.Text));
                    box.Add(row);
                }
            });
            return box;
        }

        private static VisualElement Credits(DataSourceGroup g)
        {
            // The group's title and what it feeds are the section's heading and help already.
            var box = new VisualElement();
            foreach (DataSource s in g.Sources)
            {
                box.Add(MenuDialog.Label($"{s.Name} — {s.Scope}", 12, MenuDialog.Text));
                box.Add(MenuDialog.Label($"{s.Credit}  ({s.Licence})", 11, MenuDialog.Muted));
            }
            return box;
        }

        private static VisualElement Fixed(VisualElement e, float width)
        {
            e.style.width = width;
            return e;
        }
    }
}
