using Retro.Core;
using Retro.Sim;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>
    /// settingsModel.ts SettingsDevices: what the General tab drives besides
    /// the config (the audio system and the keyboard input device).
    /// </summary>
    public interface ISettingsDevices
    {
        void SetMasterVolume(double volume);
        void SetKeyboardLayout(KeyboardControlLayoutId layout);
        void SetKeyboardPitchStickMode(KeyboardPitchStickMode mode);
    }

    /// <summary>
    /// settingsModel.ts SettingsActions: what each settings control does when
    /// moved: the setting it changes, how the slider position becomes the
    /// setting's value, and what is saved. Slider arguments are the raw thumb
    /// value. Not every change is saved here: the time of day and the terrain
    /// detail distance are saved by <see cref="PersistSettingChanges"/>, and
    /// the unit system is never saved.
    /// </summary>
    public sealed class SettingsActions
    {
        private readonly ConfigService config;
        private readonly ISettingsDevices devices;
        private readonly SettingsStorage storage;

        public SettingsActions(ConfigService config, ISettingsDevices devices, SettingsStorage storage)
        {
            this.config = config;
            this.devices = devices;
            this.storage = storage;
        }

        public ConfigService Config => config;

        /// <summary>The terrain detail slider (km; past the last step is off). Saved by the change listener.</summary>
        public void SetTerrainDetail(double km) => config.TerrainDetail.SetActive(SettingsContent.TerrainDetailFromKm(km));

        public void SetTerrainColour(TerrainColours mode)
        {
            config.TerrainColour.SetActive(mode);
            storage.Update(s => s.TerrainColour = mode);
        }

        public void SetTerrainShading(TerrainShading mode)
        {
            config.TerrainShading.SetActive(mode);
            storage.Update(s => s.TerrainShading = mode);
        }

        public void SetLanduseReach(double value)
        {
            config.LanduseReach.SetActive(value);
            double v = config.LanduseReach.Active;
            storage.Update(s => s.LanduseReach = v);
        }

        public void SetVisibleZoom(double value)
        {
            config.VisibleZoom.SetActive(value);
            double v = config.VisibleZoom.Active;
            storage.Update(s => s.VisibleZoom = v);
        }

        public void SetLanduseReveal(double value)
        {
            config.LanduseReveal.SetActive(value);
            double v = config.LanduseReveal.Active;
            storage.Update(s => s.LanduseRevealPx = v);
        }

        public void SetFarTileTextures(bool enabled)
        {
            config.FarTileTextures.SetActive(enabled);
            storage.Update(s => s.FarTileTextures = enabled);
        }

        public void SetBuildings(bool enabled)
        {
            config.Buildings.SetActive(enabled);
            storage.Update(s => s.Buildings = enabled);
        }

        public void SetRoads(RoadsMode mode)
        {
            config.Roads.SetActive(mode);
            storage.Update(s => s.Roads = mode);
        }

        /// <summary>An invalid scale leaves the setting alone but is still saved (and fails the next load), as in the TS.</summary>
        public void SetRenderScale(double scale)
        {
            config.RenderScale.SetActive(scale);
            storage.Update(s => s.RenderScale = scale);
        }

        public void SetSupersampling(bool enabled)
        {
            config.Supersampling.SetActive(enabled);
            storage.Update(s => s.Supersampling = enabled);
        }

        /// <summary><paramref name="thousands"/> is the slider's K.</summary>
        public void SetTriangleBudget(double thousands)
        {
            config.TriangleBudget.SetActive(thousands * 1000);
            double v = config.TriangleBudget.Active;
            storage.Update(s => s.TerrainTriangleBudget = v);
        }

        /// <summary>Returns the percent the slider shows; saves percent / 100 unclamped.</summary>
        public double SetLanduseBlend(double value)
        {
            double percent = JsMath.Round(value);
            config.LanduseBlend.SetActive(percent / 100);
            storage.Update(s => s.LanduseBlend = percent / 100);
            return percent;
        }

        /// <summary>Returns the multiplier the slider shows; saves it unclamped.</summary>
        public double SetTreeDensity(double value)
        {
            double multiplier = JsMath.Round(value);
            config.TreeDensity.SetActive(multiplier);
            storage.Update(s => s.TreeDensity = multiplier);
            return multiplier;
        }

        /// <summary><paramref name="current"/> is the adjust the sliders were showing.</summary>
        public void SetColourTweak(ColourAdjust current, ColourAdjustGroup group, ColourChannelOption channel, double value)
        {
            double scaled = JsMath.Round(value) / channel.Scale;
            config.ColourAdjust.SetTweak(group, current[group].With(channel.Channel, scaled));
            SaveColourAdjust();
        }

        public void ResetColourAdjust()
        {
            ColourAdjust defaults = ColourAdjust.Default;
            foreach (ColourAdjustGroup group in ColourAdjust.Groups)
            {
                config.ColourAdjust.SetTweak(group, defaults[group]);
            }
            SaveColourAdjust();
        }

        private void SaveColourAdjust()
        {
            ColourAdjust adjust = config.ColourAdjust.Active;
            storage.Update(s => s.ColourAdjust = adjust);
        }

        /// <summary>Saved by the change listener.</summary>
        public void SetDaytime(double hours) => config.Daytime.SetActive(hours);

        public void SetFlightModel(string id)
        {
            config.FlightModels.SetActive(id);
            storage.Update(s => s.FlightModel = id);
        }

        public void SetAiPilotModel(AiPilotModels model)
        {
            config.AiPilotModels.SetActive(model);
            storage.Update(s => s.AiPilotModel = model);
        }

        /// <summary>Never saved: every session starts metric, as on the web.</summary>
        public void SetUnitSystem(UnitSystems system) => config.UnitSystem.SetActive(system);

        /// <summary>Returns the percent the slider shows; saves percent / 100 unclamped.</summary>
        public double SetVolume(double value)
        {
            double percent = JsMath.Round(value);
            devices.SetMasterVolume(percent / 100);
            storage.Update(s => s.Volume = percent / 100);
            return percent;
        }

        public void SetKeyboardLayout(KeyboardControlLayoutId layout)
        {
            devices.SetKeyboardLayout(layout);
            storage.Update(s => s.KeyboardLayout = layout);
        }

        public void SetPitchStickMode(KeyboardPitchStickMode mode)
        {
            devices.SetKeyboardPitchStickMode(mode);
            storage.Update(s => s.KeyboardPitchStickMode = mode);
        }

        /// <summary>
        /// settingsModel.ts persistSettingChanges: time of day and terrain
        /// detail can change from outside the dialog (the N key writes the time
        /// of day), so they are saved from the settings' change listeners for
        /// the whole session. Off (+Infinity) is saved as null.
        /// </summary>
        public static void PersistSettingChanges(ConfigService config, SettingsStorage storage)
        {
            config.Daytime.AddChangeListener(hours => storage.Update(s => s.Daytime = hours));
            config.TerrainDetail.AddChangeListener(distanceM =>
                storage.Update(s => s.TerrainDetailDistanceM = JsText.IsFinite(distanceM) ? distanceM : (double?)null));
        }

        /// <summary>
        /// The boot path of index.ts and osdPanel.ts in one: load the stored
        /// settings, build the live config from them, start saving the time of
        /// day and terrain detail, and give the devices their stored values.
        /// </summary>
        public static ConfigService Boot(SettingsStorage storage, ISettingsDevices devices, out AppSettings settings)
        {
            settings = storage.Load();
            ConfigService config = ConfigService.FromSettings(settings);
            devices?.SetKeyboardLayout(settings.KeyboardLayout);
            devices?.SetKeyboardPitchStickMode(settings.KeyboardPitchStickMode);
            devices?.SetMasterVolume(settings.Volume);
            PersistSettingChanges(config, storage);
            return config;
        }
    }
}
