using UnityEngine;
using UnityEngine.UIElements;

namespace Retro.Unity
{
    /// <summary>
    /// The two small labels that follow the pointer (index.html #showcase-pick,
    /// game.ts coverTooltipEl): the showcase's "Mesh: name" at the top left,
    /// and the land cover under a resting mouse beside the cursor.
    /// </summary>
    public sealed class PointerLabels : MonoBehaviour
    {
        private Label pick, tooltip;

        /// <summary>The showcase's part under the pointer; null hides it.</summary>
        public string Pick { get; set; }

        /// <summary>The land-cover tooltip's text and screen position (UI Toolkit, y down); null hides it.</summary>
        public string Tooltip { get; set; }
        public Vector2 TooltipAt { get; set; }

        private void Start()
        {
            var document = gameObject.AddComponent<UIDocument>();
            document.panelSettings = Resources.Load<PanelSettings>("RetroPanelSettings");
            document.sortingOrder = 120;
            VisualElement root = document.rootVisualElement;
            root.pickingMode = PickingMode.Ignore;
            pick = MakeLabel(13);
            pick.style.left = 16;
            pick.style.top = 16;
            pick.style.maxWidth = Length.Percent(40);
            root.Add(pick);
            tooltip = MakeLabel(13);
            root.Add(tooltip);
        }

        private static Label MakeLabel(int size)
        {
            var l = new Label { pickingMode = PickingMode.Ignore };
            MenuDialog.Style(l, s =>
            {
                s.position = Position.Absolute;
                s.paddingLeft = s.paddingRight = 10;
                s.paddingTop = s.paddingBottom = 5;
                s.color = Color.white;
                s.fontSize = size;
                s.backgroundColor = new Color(0, 0, 0, 0.8f);
                s.borderTopWidth = s.borderBottomWidth = s.borderLeftWidth = s.borderRightWidth = 1;
                s.borderTopColor = s.borderBottomColor = s.borderLeftColor = s.borderRightColor = (Color)new Color32(138, 138, 138, 255);
                MenuDialog.Round(s, 4);
                s.display = DisplayStyle.None;
            });
            return l;
        }

        private void LateUpdate()
        {
            if (pick == null) return;
            pick.text = Pick != null ? "Mesh: " + Pick : "";
            pick.style.display = Pick != null ? DisplayStyle.Flex : DisplayStyle.None;
            tooltip.text = Tooltip ?? "";
            tooltip.style.display = Tooltip != null ? DisplayStyle.Flex : DisplayStyle.None;
            if (Tooltip != null)
            {
                // Beside the cursor (14, 18 px), in panel units.
                Vector2 p = RuntimePanelUtils.ScreenToPanel(tooltip.panel, TooltipAt);
                tooltip.style.left = p.x + 14;
                tooltip.style.top = p.y + 18;
            }
        }
    }
}
