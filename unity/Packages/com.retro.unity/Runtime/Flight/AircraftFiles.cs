using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Threading.Tasks;
using Retro.Core;
using Retro.Game;
using UnityEngine;
#if RETRO_GLTFAST
using GLTFast.Loading;
#endif

namespace Retro.Unity
{
    /// <summary>Where an aircraft's model files come from: the repo's assets folder or a mod pack.</summary>
    public interface IAircraftFiles
    {
        /// <summary>A file by name (a pack stores everything by basename).</summary>
        bool TryRead(string file, out byte[] data);
        string Label { get; }
    }

    public sealed class DirectoryFiles : IAircraftFiles
    {
        private readonly string dir;

        public DirectoryFiles(string dir) => this.dir = dir;

        public string Label => dir;

        public bool TryRead(string file, out byte[] data)
        {
            string path = Path.Combine(dir, file);
            data = File.Exists(path) ? File.ReadAllBytes(path) : null;
            return data != null;
        }
    }

    /// <summary>
    /// A `.aircraft.pack` (aircraftPack.ts): a zip of manifest.json and the
    /// glTF/bin files flattened by basename. Only the manifest is read up
    /// front; the model files come out of the zip when the aircraft is flown.
    /// </summary>
    public sealed class AircraftPack : IAircraftFiles
    {
        private readonly string path;
        private readonly Dictionary<string, byte[]> files = new Dictionary<string, byte[]>(StringComparer.Ordinal);

        public readonly string Id;
        public readonly FlyableAircraftDef Def;
        public string Label => Id;

        public AircraftPack(string path)
        {
            Id = Path.GetFileName(path);
            if (Id.EndsWith(".aircraft.pack", StringComparison.Ordinal)) Id = Id.Substring(0, Id.Length - ".aircraft.pack".Length);
            this.path = path;
            if (!TryRead("manifest.json", out byte[] manifest)) throw new InvalidDataException($"{path}: no manifest.json");
            files.Remove("manifest.json");
            Def = AircraftDefs.FromPackManifest(Id, JsonReader.Parse(System.Text.Encoding.UTF8.GetString(manifest)));
        }

        public bool TryRead(string file, out byte[] data)
        {
            string name = AircraftDefs.PackEntry(file);
            lock (files)
            {
                if (files.TryGetValue(name, out data)) return true;
                using (var zip = new ZipArchive(File.OpenRead(path), ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry e in zip.Entries)
                    {
                        if (AircraftDefs.PackEntry(e.FullName) != name) continue;
                        using (Stream s = e.Open())
                        using (var m = new MemoryStream())
                        {
                            s.CopyTo(m);
                            data = m.ToArray();
                        }
                        files[name] = data;
                        return true;
                    }
                }
            }
            data = null;
            return false;
        }
    }

    /// <summary>The flyable aircraft on this machine: the built-in F-22 and every pack in dist/assets (aircraftRegistry.ts).</summary>
    public static class AircraftCatalogue
    {
        public sealed class Entry
        {
            public FlyableAircraftDef Def;
            public IAircraftFiles Files;
        }

        /// <summary>Walks up from the project to the repo's assets and dist/assets folders.</summary>
        public static List<Entry> Load(string assetsDir)
        {
            var list = new List<Entry> { new Entry { Def = AircraftDefs.F22(), Files = new DirectoryFiles(assetsDir) } };
            string dist = Path.Combine(Path.GetDirectoryName(assetsDir) ?? "", "dist", "assets");
            if (!Directory.Exists(dist)) return list;
            string[] packs = Directory.GetFiles(dist, "*.aircraft.pack");
            Array.Sort(packs, StringComparer.Ordinal);
            foreach (string p in packs)
            {
                try
                {
                    var pack = new AircraftPack(p);
                    if (AircraftDefs.IsExcludedPack(pack.Id)) continue;
                    list.Add(new Entry { Def = pack.Def, Files = pack });
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"Retro aircraft: skipped {Path.GetFileName(p)} ({e.Message})");
                }
            }
            return list;
        }
    }

#if RETRO_GLTFAST
    /// <summary>glTFast's buffer and image requests answered from an aircraft's files, by basename.</summary>
    public sealed class FilesDownloadProvider : IDownloadProvider
    {
        private readonly IAircraftFiles files;

        public FilesDownloadProvider(IAircraftFiles files) => this.files = files;

        public Task<IDownload> Request(Uri url)
        {
            string name = AircraftDefs.PackEntry(Uri.UnescapeDataString(url.IsAbsoluteUri ? url.AbsolutePath : url.OriginalString));
            files.TryRead(name, out byte[] data);
            return Task.FromResult<IDownload>(new Download(data, name));
        }

        public Task<ITextureDownload> RequestTexture(Uri url, bool nonReadable)
        {
            string name = AircraftDefs.PackEntry(Uri.UnescapeDataString(url.IsAbsoluteUri ? url.AbsolutePath : url.OriginalString));
            files.TryRead(name, out byte[] data);
            return Task.FromResult<ITextureDownload>(new TextureDownload(data, name, nonReadable));
        }

        private class Download : IDownload
        {
            public Download(byte[] data, string name)
            {
                Data = data;
                Error = data == null ? $"{name} not found" : null;
            }

            public bool Success => Data != null;
            public string Error { get; }
            public byte[] Data { get; }
            public string Text => Data != null ? System.Text.Encoding.UTF8.GetString(Data) : null;
            public bool? IsBinary => Data != null && Data.Length >= 4 ? Data[0] == 'g' && Data[1] == 'l' && Data[2] == 'T' && Data[3] == 'F' : (bool?)null;
            public void Dispose() { }
        }

        private sealed class TextureDownload : Download, ITextureDownload
        {
            public TextureDownload(byte[] data, string name, bool nonReadable) : base(data, name)
            {
                if (data == null) return;
                var tex = new Texture2D(2, 2);
                tex.LoadImage(data, nonReadable);
                Texture = tex;
            }

            public Texture2D Texture { get; }
        }
    }
#endif
}
