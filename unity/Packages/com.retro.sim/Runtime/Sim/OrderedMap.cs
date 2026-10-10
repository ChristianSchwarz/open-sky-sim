using System.Collections;
using System.Collections.Generic;

namespace Retro.Sim
{
    /// <summary>
    /// A JavaScript Map: iteration in insertion order, and setting an existing key
    /// keeps its place. Deleting during iteration is not supported; iterate a
    /// <see cref="Keys"/> snapshot instead.
    /// </summary>
    public sealed class OrderedMap<TKey, TValue> : IEnumerable<KeyValuePair<TKey, TValue>>
    {
        private readonly Dictionary<TKey, TValue> map = new Dictionary<TKey, TValue>();
        private readonly List<TKey> order = new List<TKey>();

        public int Count => order.Count;

        public bool Has(TKey key) => map.ContainsKey(key);

        public TValue Get(TKey key) => map.TryGetValue(key, out TValue v) ? v : default;

        public bool TryGet(TKey key, out TValue value) => map.TryGetValue(key, out value);

        public void Set(TKey key, TValue value)
        {
            if (!map.ContainsKey(key))
            {
                order.Add(key);
            }
            map[key] = value;
        }

        public bool Delete(TKey key)
        {
            if (!map.Remove(key))
            {
                return false;
            }
            order.Remove(key);
            return true;
        }

        public void Clear()
        {
            map.Clear();
            order.Clear();
        }

        /// <summary>A snapshot of the keys, in insertion order.</summary>
        public List<TKey> Keys => new List<TKey>(order);

        /// <summary>The values, in insertion order (a snapshot).</summary>
        public List<TValue> Values
        {
            get
            {
                var list = new List<TValue>(order.Count);
                foreach (TKey k in order) list.Add(map[k]);
                return list;
            }
        }

        public IEnumerator<KeyValuePair<TKey, TValue>> GetEnumerator()
        {
            foreach (TKey k in new List<TKey>(order))
            {
                if (map.TryGetValue(k, out TValue v))
                {
                    yield return new KeyValuePair<TKey, TValue>(k, v);
                }
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
