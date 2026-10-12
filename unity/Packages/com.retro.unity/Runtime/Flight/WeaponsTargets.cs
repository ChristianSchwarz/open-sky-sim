using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using Retro.Sim;

namespace Retro.Unity
{
    /// <summary>
    /// The player's weapons target and what it can be (player.ts target,
    /// pickTarget, collectWeaponsTargets): the ground installations in the
    /// order they joined the scene (the airfields as they are built, the
    /// authored runway, the carrier, the Canaries targets), then every live
    /// enemy aircraft. T steps through them and past the last one to none.
    /// An airfield or the carrier as the target is what brings up the ILS.
    /// </summary>
    public sealed class WeaponsTargets
    {
        /// <summary>A designatable target: a ground installation, or an aircraft in the sim.</summary>
        public sealed class Entry
        {
            public string Type = "", Location = "";
            /// <summary>Where it is now (the carrier moves).</summary>
            public Func<Vec3d> Position;
            public Vec3d LocalCenter;
            public double MaxSize = 100;
            /// <summary>An airfield's primary runway, for the ILS.</summary>
            public ApproachRunway Runway;
            /// <summary>The sim id of an aircraft target; null on the ground.</summary>
            public string SimId;
        }

        private readonly List<Entry> ground = new List<Entry>();
        private readonly Dictionary<string, Entry> aircraft = new Dictionary<string, Entry>();
        private readonly List<Entry> scratch = new List<Entry>();

        /// <summary>The designated target, or null.</summary>
        public Entry Current { get; private set; }

        /// <summary>A ground installation joins the scene (GroundTargetEntity added with the TARGET tag).</summary>
        public void AddGround(Entry e) => ground.Add(e);

        /// <summary>setWeaponsTarget: an aircraft by sim id, or none.</summary>
        public void SetAircraft(string id) => Current = id == null ? null : AircraftEntry(id);

        public void Clear() => Current = null;

        private Entry AircraftEntry(string id)
        {
            if (!aircraft.TryGetValue(id, out Entry e))
            {
                e = new Entry { SimId = id };
                aircraft[id] = e;
            }
            return e;
        }

        /// <summary>collectWeaponsTargets: the ground installations, then the enemy aircraft alive.</summary>
        public List<Entry> Collect(CombatSim sim, List<Entry> into)
        {
            into.Clear();
            into.AddRange(ground);
            foreach (SimAircraft a in sim.Aircraft)
            {
                if (a.Faction == Faction.ENEMY && a.IsAlive()) into.Add(AircraftEntry(a.Id));
            }
            return into;
        }

        /// <summary>pickTarget: the next candidate after the current one; past the last, none.</summary>
        public void Cycle(CombatSim sim)
        {
            List<Entry> candidates = Collect(sim, scratch);
            if (candidates.Count == 0)
            {
                Current = null;
                return;
            }
            int next = (Current != null ? candidates.IndexOf(Current) : -1) + 1;
            Current = next >= candidates.Count ? null : candidates[next];
        }

        /// <summary>A ground entry as the HUD, cameras and padlock read it.</summary>
        public static WeaponsTarget Ground(Entry e) => new WeaponsTarget
        {
            Position = e.Position(),
            LocalCenter = e.LocalCenter,
            MaxSize = e.MaxSize,
            TargetType = e.Type,
            TargetLocation = e.Location,
            Airborne = false,
            ApproachRunway = e.Runway,
        };

        /// <summary>A ground entry as the target MFD reads it: no telemetry.</summary>
        public static CockpitTarget GroundCockpit(Entry e) => new CockpitTarget
        {
            Position = e.Position(),
            LocalCenter = e.LocalCenter,
            MaxSize = e.MaxSize,
            TargetType = e.Type,
            TargetLocation = e.Location,
            Airborne = false,
        };
    }
}
