using System;
using System.IO;
using Retro.Sim;
using UnityEngine;
using UnityEngine.Networking;

namespace Retro.Unity
{
    /// <summary>
    /// The engine sound (player.ts updateAudio, audioSystem.ts): two looping
    /// clips, engine-loop-02 heard from the cockpit and engine-loop-01 from
    /// outside, swapped by the view and silenced by a crash. Pitch follows
    /// 0.25 + 1.75 easeOutQuad(throttle), volume easeOutQuint(throttle), held
    /// at a floor once the engine has run. The master volume is the
    /// <see cref="AudioListener"/>'s (Settings, General tab).
    ///
    /// As on the web a clip, once started, keeps running: "stop" mutes it
    /// (audioSystem.ts disconnects its gain node), so swapping views does not
    /// restart the loop.
    /// </summary>
    public sealed class EngineAudio : IDisposable
    {
        // player.ts ENGINE_LOWEST_VOLUME.
        private const double LowestVolume = 0.05;

        private readonly Clip inside, outside;
        private bool exterior = true;
        private bool playing;
        private bool started;

        /// <param name="assetsDir">The repo's assets/ (the clips sit beside the terrain).</param>
        public EngineAudio(Transform host, string assetsDir)
        {
            if (UnityEngine.Object.FindAnyObjectByType<AudioListener>() == null)
            {
                Camera cam = Camera.main;
                if (cam != null) cam.gameObject.AddComponent<AudioListener>();
            }
            inside = new Clip(host, "Engine (cockpit)", Path.Combine(assetsDir, "engine-loop-02.ogg"));
            outside = new Clip(host, "Engine (exterior)", Path.Combine(assetsDir, "engine-loop-01.ogg"));
        }

        /// <summary>The exteriorView setter: a running engine moves to the other clip.</summary>
        public bool Exterior
        {
            set
            {
                if (value == exterior) return;
                exterior = value;
                if (!playing) return;
                (exterior ? inside : outside).Stop();
                (exterior ? outside : inside).Play();
            }
        }

        /// <summary>updateAudio, once a frame while the flight runs.</summary>
        public void Update(SimAircraft aircraft)
        {
            inside.Poll();
            outside.Poll();
            Clip engine = exterior ? outside : inside;
            if (aircraft.IsCrashed())
            {
                if (playing)
                {
                    engine.Stop();
                    playing = false;
                }
                return;
            }
            double throttle = aircraft.Model.ThrottleAudioLevel;
            if (throttle > 0 && !playing)
            {
                engine.Play();
                playing = true;
            }
            if (!playing) return;
            if (throttle > LowestVolume) started = true;
            if (started) throttle = Math.Max(LowestVolume, throttle);
            double quad = 1 - (1 - throttle) * (1 - throttle);
            double quint = 1 - Math.Pow(1 - throttle, 5);
            engine.Rate = (float)(0.25 + 1.75 * quad);
            engine.Gain = (float)quint;
        }

        public void Dispose()
        {
            inside.Dispose();
            outside.Dispose();
        }

        /// <summary>audioSystem.ts AudioClip over an AudioSource: loaded off disk, looping, muted for "stop".</summary>
        private sealed class Clip : IDisposable
        {
            private readonly AudioSource source;
            private UnityWebRequest request;
            private bool wantPlay, started, muted;
            private float gain = 1;

            public Clip(Transform host, string name, string path)
            {
                var go = new GameObject(name);
                go.transform.SetParent(host, false);
                source = go.AddComponent<AudioSource>();
                source.loop = true;
                source.playOnAwake = false;
                source.spatialBlend = 0;
                source.volume = 0;
                if (File.Exists(path))
                {
                    request = UnityWebRequestMultimedia.GetAudioClip(new Uri(path).AbsoluteUri, AudioType.OGGVORBIS);
                    request.SendWebRequest();
                }
                else
                {
                    Debug.LogWarning($"Engine sound missing: {path}");
                }
            }

            /// <summary>The clip arrives (resources.load's callback); a play asked for meanwhile starts it.</summary>
            public void Poll()
            {
                if (request == null || !request.isDone) return;
                if (request.result == UnityWebRequest.Result.Success)
                {
                    source.clip = DownloadHandlerAudioClip.GetContent(request);
                    if (wantPlay) Start();
                }
                else
                {
                    Debug.LogWarning($"Engine sound failed to load: {request.error}");
                }
                request.Dispose();
                request = null;
            }

            public float Rate
            {
                set => source.pitch = value;
            }

            public float Gain
            {
                set
                {
                    gain = value;
                    if (!muted) source.volume = value;
                }
            }

            public void Play()
            {
                muted = false;
                source.volume = gain;
                if (!started)
                {
                    wantPlay = true;
                    if (source.clip != null) Start();
                }
            }

            public void Stop()
            {
                muted = true;
                source.volume = 0;
            }

            private void Start()
            {
                started = true;
                source.Play();
            }

            public void Dispose()
            {
                request?.Dispose();
                if (source != null) UnityEngine.Object.Destroy(source.gameObject);
            }
        }
    }
}
