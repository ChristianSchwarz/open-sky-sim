using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// A byte-budget LRU cache of decoded tiles read from a local pyramid
    /// (the role of tileStore.ts, with file reads instead of HTTP fetches).
    ///
    /// Loads run on the thread pool: read, inflate, decode. Results are handed
    /// back through a queue and only become visible in <see cref="Pump"/>, which
    /// the owner calls once per frame on its own thread, so every other member
    /// is single-threaded. A missing file is remembered as absent (sea).
    /// </summary>
    public sealed class TileCache<T> where T : class
    {
        private sealed class Entry
        {
            public TileKey Key;
            public T Value;
            public long Bytes;
            public long LastUsed;
            public bool Pinned;
            public LinkedListNode<Entry> Node;
        }

        private struct Completed
        {
            public TileKey Key;
            public T Value;
            public long Bytes;
            public bool Absent;
            public string Error;
        }

        private readonly Func<TileKey, string> pathFor;
        private readonly Func<byte[], T> decode;
        private readonly Func<T, long> sizeOf;
        private readonly long budgetBytes;
        private readonly int maxConcurrent;

        private readonly Dictionary<TileKey, Entry> entries = new Dictionary<TileKey, Entry>();
        private readonly LinkedList<Entry> lru = new LinkedList<Entry>();
        private readonly HashSet<TileKey> absent = new HashSet<TileKey>();
        private readonly HashSet<TileKey> inFlight = new HashSet<TileKey>();
        private readonly ConcurrentQueue<Completed> completed = new ConcurrentQueue<Completed>();
        private List<(TileKey Key, double Priority)> wants = new List<(TileKey, double)>();
        private long generation;
        private long residentBytes;

        /// <summary>Called on the owner's thread for each tile that became resident in Pump.</summary>
        public event Action<TileKey, T> Loaded;

        /// <summary>Called on the owner's thread for each tile evicted from the cache.</summary>
        public event Action<TileKey, T> Evicted;

        public TileCache(Func<TileKey, string> pathFor, Func<byte[], T> decode, Func<T, long> sizeOf,
            long budgetBytes, int maxConcurrent = 8)
        {
            this.pathFor = pathFor;
            this.decode = decode;
            this.sizeOf = sizeOf;
            this.budgetBytes = budgetBytes;
            this.maxConcurrent = Math.Max(1, maxConcurrent);
        }

        public int Count => entries.Count;
        public long ResidentBytes => residentBytes;
        public int InFlight => inFlight.Count;
        public int Failures { get; private set; }
        public string LastError { get; private set; }

        public bool IsAbsent(TileKey key) => absent.Contains(key);

        /// <summary>The resident value, touching it for LRU; null if not loaded.</summary>
        public T Get(TileKey key)
        {
            if (!entries.TryGetValue(key, out Entry e)) return null;
            e.LastUsed = generation;
            lru.Remove(e.Node);
            lru.AddLast(e.Node);
            return e.Value;
        }

        /// <summary>The resident value without touching the LRU (for CPU queries that must not reorder it).</summary>
        public T Peek(TileKey key) => entries.TryGetValue(key, out Entry e) ? e.Value : null;

        public bool Has(TileKey key) => entries.ContainsKey(key);

        /// <summary>Pinned tiles are never evicted (boot and spawn area).</summary>
        public void Pin(TileKey key, bool pinned = true)
        {
            if (entries.TryGetValue(key, out Entry e)) e.Pinned = pinned;
        }

        /// <summary>Start of a reconcile: tiles used from now on are protected from this round's eviction.</summary>
        public void NextGeneration() => generation++;

        /// <summary>Replace the want set; the highest priority loads start first.</summary>
        public void SetWants(IEnumerable<(TileKey Key, double Priority)> list)
        {
            wants = new List<(TileKey, double)>(list);
            wants.Sort((a, b) => b.Item2.CompareTo(a.Item2));
        }

        /// <summary>Collect finished loads, evict over budget, start new loads. Call once per frame.</summary>
        public void Pump()
        {
            while (completed.TryDequeue(out Completed c))
            {
                inFlight.Remove(c.Key);
                if (c.Absent)
                {
                    absent.Add(c.Key);
                    continue;
                }
                if (c.Error != null)
                {
                    Failures++;
                    LastError = c.Error;
                    continue;
                }
                if (entries.ContainsKey(c.Key)) continue;
                var e = new Entry { Key = c.Key, Value = c.Value, Bytes = c.Bytes, LastUsed = generation };
                e.Node = lru.AddLast(e);
                entries[c.Key] = e;
                residentBytes += c.Bytes;
                Loaded?.Invoke(c.Key, c.Value);
            }
            EvictOverBudget();
            foreach (var (key, _) in wants)
            {
                if (inFlight.Count >= maxConcurrent) break;
                if (entries.ContainsKey(key) || absent.Contains(key) || inFlight.Contains(key)) continue;
                StartLoad(key);
            }
        }

        private void EvictOverBudget()
        {
            LinkedListNode<Entry> node = lru.First;
            while (residentBytes > budgetBytes && node != null)
            {
                LinkedListNode<Entry> next = node.Next;
                Entry e = node.Value;
                if (!e.Pinned && e.LastUsed < generation)
                {
                    lru.Remove(node);
                    entries.Remove(e.Key);
                    residentBytes -= e.Bytes;
                    Evicted?.Invoke(e.Key, e.Value);
                }
                node = next;
            }
        }

        private void StartLoad(TileKey key)
        {
            inFlight.Add(key);
            string path = pathFor(key);
            Task.Run(() =>
            {
                try
                {
                    if (!File.Exists(path))
                    {
                        completed.Enqueue(new Completed { Key = key, Absent = true });
                        return;
                    }
                    T value = decode(File.ReadAllBytes(path));
                    completed.Enqueue(new Completed { Key = key, Value = value, Bytes = sizeOf(value) });
                }
                catch (Exception ex)
                {
                    completed.Enqueue(new Completed { Key = key, Error = $"{key}: {ex.Message}" });
                }
            });
        }

        /// <summary>Block until nothing is in flight (tests and boot); Pump is called while waiting.</summary>
        public bool WaitIdle(TimeSpan timeout)
        {
            DateTime end = DateTime.UtcNow + timeout;
            while (inFlight.Count > 0 || !completed.IsEmpty)
            {
                Pump();
                if (DateTime.UtcNow > end) return false;
                Thread.Sleep(1);
            }
            Pump();
            return true;
        }
    }
}
