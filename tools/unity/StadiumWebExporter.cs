// StadiumSync 3D — Unity → web exporter.
//
// One-time offline tool. Copy this file into `<unity project>/Assets/Editor/`, open
// SPRING25_Stadium.unity, and run  StadiumSync → Export for Web  (or headless, see
// tools/README.md). It writes, into the chosen folder:
//
//   stadium.glb    the Auburn stadium FBX, world transforms baked in, as a single glTF
//                  binary. Textures are NOT embedded: materials reference
//                  `stadium_diffuse.jpg` by URI so build_web_assets.py can resize it.
//   leds_raw.json  every LED-tagged object: world position, deck, section, row.
//
// Coordinates: Unity is left-handed, glTF/three.js are right-handed. Everything is
// mirrored with x → -x (and triangle winding reversed) so mesh and LEDs stay aligned.
// `upos` in leds_raw.json keeps the raw Unity world position (rounded to 3 decimals,
// exactly like GlobalController) so the Spring '25 show frames can be matched to LEDs.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public static class StadiumWebExporter
{
    const string ScenePath = "Assets/Scenes/SPRING25_Stadium.unity";
    const string StadiumModelPath = "Assets/Art/Models/AuburnArena/Auburn-Stadium-Part1/Auburn Stadium_3Dmodel.fbx";
    const string TextureUri = "stadium_diffuse.jpg";

    [MenuItem("StadiumSync/Export for Web")]
    public static void ExportMenu()
    {
        string dir = EditorUtility.SaveFolderPanel("Export StadiumSync web assets", "", "export_raw");
        if (!string.IsNullOrEmpty(dir)) Export(dir);
    }

    // Headless entry point:
    //   Unity -batchmode -quit -projectPath <proj> -executeMethod StadiumWebExporter.ExportBatch -exportDir <dir>
    public static void ExportBatch()
    {
        string[] args = Environment.GetCommandLineArgs();
        string dir = null;
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "-exportDir") dir = args[i + 1];
        if (dir == null) throw new ArgumentException("missing -exportDir <dir>");
        EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
        Export(dir);
    }

    static void Export(string dir)
    {
        Directory.CreateDirectory(dir);
        ExportStadiumGlb(Path.Combine(dir, "stadium.glb"));
        ExportLeds(Path.Combine(dir, "leds_raw.json"));
        Debug.Log("[StadiumWebExporter] export complete → " + dir);
    }

    // ---------------------------------------------------------------- LEDs

    static void ExportLeds(string path)
    {
        GameObject[] leds = GameObject.FindGameObjectsWithTag("LED");
        var sb = new StringBuilder(leds.Length * 160);
        sb.Append("{\"leds\":[\n");
        int written = 0;
        foreach (GameObject led in leds)
        {
            Transform t = led.transform;
            Transform row = null, section = null, deck = null;
            for (Transform p = t.parent; p != null; p = p.parent)
            {
                if (row == null && p.name.StartsWith("Row")) row = p;
                if (p.parent != null && p.parent.name.Trim().EndsWith("Deck")) { section = p; deck = p.parent; break; }
            }
            if (section == null) { Debug.LogWarning("LED outside any deck: " + HierarchyPath(t)); continue; }

            Vector3 w = t.position;
            if (written++ > 0) sb.Append(",\n");
            sb.Append("{\"pos\":[").Append(F(-w.x)).Append(',').Append(F(w.y)).Append(',').Append(F(w.z)).Append(']');
            sb.Append(",\"upos\":[").Append(R3(w.x)).Append(',').Append(R3(w.y)).Append(',').Append(R3(w.z)).Append(']');
            sb.Append(",\"deck\":\"").Append(deck.name.Trim()).Append('"');
            sb.Append(",\"section\":").Append(section.GetInstanceID());
            sb.Append(",\"sectionName\":\"").Append(section.name).Append('"');
            sb.Append(",\"row\":").Append(row != null ? row.GetInstanceID() : 0);
            sb.Append('}');
        }
        sb.Append("\n]}\n");
        File.WriteAllText(path, sb.ToString());
        Debug.Log("[StadiumWebExporter] wrote " + written + " LEDs");
    }

    static string HierarchyPath(Transform t)
    {
        string s = t.name;
        for (Transform p = t.parent; p != null; p = p.parent) s = p.name + "/" + s;
        return s;
    }

    static string F(float v) { return v.ToString("0.#####", CultureInfo.InvariantCulture); }
    static string R3(float v) { return (Mathf.Round(v * 1000f) / 1000f).ToString("0.###", CultureInfo.InvariantCulture); }

    // ---------------------------------------------------------------- stadium mesh → GLB

    static void ExportStadiumGlb(string path)
    {
        var renderers = new List<MeshRenderer>();
        foreach (MeshRenderer mr in UnityEngine.Object.FindObjectsByType<MeshRenderer>(FindObjectsSortMode.None))
        {
            MeshFilter mf = mr.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) continue;
            if (AssetDatabase.GetAssetPath(mf.sharedMesh) == StadiumModelPath) renderers.Add(mr);
        }
        if (renderers.Count == 0) throw new Exception("stadium model not found in scene");

        // One glTF primitive per (renderer, submesh). Materials deduplicated by name.
        var bin = new MemoryStream();
        var accessors = new List<string>();
        var bufferViews = new List<string>();
        var primitives = new List<string>();
        var materialIndex = new Dictionary<string, int>();
        var materials = new List<string>();

        foreach (MeshRenderer mr in renderers)
        {
            Mesh mesh = mr.GetComponent<MeshFilter>().sharedMesh;
            Matrix4x4 m = mr.transform.localToWorldMatrix;
            Matrix4x4 n = m.inverse.transpose;

            Vector3[] v = mesh.vertices;
            Vector3[] nrm = mesh.normals;
            Vector2[] uv = mesh.uv;
            var pos = new float[v.Length * 3];
            var nor = new float[v.Length * 3];
            var min = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
            var max = new Vector3(float.MinValue, float.MinValue, float.MinValue);
            for (int i = 0; i < v.Length; i++)
            {
                Vector3 p = m.MultiplyPoint3x4(v[i]);
                p.x = -p.x;
                pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
                min = Vector3.Min(min, p); max = Vector3.Max(max, p);
                Vector3 q = nrm.Length == v.Length ? n.MultiplyVector(nrm[i]).normalized : Vector3.up;
                nor[i * 3] = -q.x; nor[i * 3 + 1] = q.y; nor[i * 3 + 2] = q.z;
            }
            int posAcc = AddAccessor(bin, bufferViews, accessors, pos, v.Length, "VEC3", 34962,
                "\"min\":[" + F(min.x) + "," + F(min.y) + "," + F(min.z) + "],\"max\":[" + F(max.x) + "," + F(max.y) + "," + F(max.z) + "]");
            int norAcc = AddAccessor(bin, bufferViews, accessors, nor, v.Length, "VEC3", 34962, null);
            int uvAcc = -1;
            if (uv.Length == v.Length)
            {
                var uvf = new float[uv.Length * 2];
                for (int i = 0; i < uv.Length; i++) { uvf[i * 2] = uv[i].x; uvf[i * 2 + 1] = 1f - uv[i].y; }
                uvAcc = AddAccessor(bin, bufferViews, accessors, uvf, uv.Length, "VEC2", 34962, null);
            }

            Material[] mats = mr.sharedMaterials;
            for (int s = 0; s < mesh.subMeshCount; s++)
            {
                int[] tri = mesh.GetTriangles(s);
                var idx = new uint[tri.Length];
                for (int i = 0; i < tri.Length; i += 3)
                {   // mirroring flips handedness, so reverse winding
                    idx[i] = (uint)tri[i]; idx[i + 1] = (uint)tri[i + 2]; idx[i + 2] = (uint)tri[i + 1];
                }
                int idxAcc = AddIndexAccessor(bin, bufferViews, accessors, idx);

                Material mat = s < mats.Length ? mats[s] : null;
                string key = mat != null ? mat.name : "default";
                if (!materialIndex.TryGetValue(key, out int mi))
                {
                    mi = materials.Count;
                    materialIndex[key] = mi;
                    materials.Add(MaterialJson(mat, uvAcc >= 0));
                }
                string attrs = "\"POSITION\":" + posAcc + ",\"NORMAL\":" + norAcc + (uvAcc >= 0 ? ",\"TEXCOORD_0\":" + uvAcc : "");
                primitives.Add("{\"attributes\":{" + attrs + "},\"indices\":" + idxAcc + ",\"material\":" + mi + "}");
            }
        }

        bool anyTex = materials.Exists(s => s.Contains("baseColorTexture"));
        var json = new StringBuilder();
        json.Append("{\"asset\":{\"version\":\"2.0\",\"generator\":\"StadiumSync StadiumWebExporter\"},");
        json.Append("\"scene\":0,\"scenes\":[{\"nodes\":[0]}],");
        json.Append("\"nodes\":[{\"name\":\"stadium\",\"mesh\":0}],");
        json.Append("\"meshes\":[{\"name\":\"stadium\",\"primitives\":[").Append(string.Join(",", primitives)).Append("]}],");
        json.Append("\"materials\":[").Append(string.Join(",", materials)).Append("],");
        if (anyTex)
        {
            json.Append("\"samplers\":[{\"magFilter\":9729,\"minFilter\":9987,\"wrapS\":10497,\"wrapT\":10497}],");
            json.Append("\"images\":[{\"uri\":\"").Append(TextureUri).Append("\"}],");
            json.Append("\"textures\":[{\"sampler\":0,\"source\":0}],");
        }
        json.Append("\"buffers\":[{\"byteLength\":").Append(bin.Length).Append("}],");
        json.Append("\"bufferViews\":[").Append(string.Join(",", bufferViews)).Append("],");
        json.Append("\"accessors\":[").Append(string.Join(",", accessors)).Append("]}");

        WriteGlb(path, json.ToString(), bin.ToArray());
        Debug.Log("[StadiumWebExporter] wrote stadium.glb: " + renderers.Count + " renderers, " + primitives.Count + " primitives, " + materials.Count + " materials");
        foreach (var kv in materialIndex) Debug.Log("[StadiumWebExporter] material " + kv.Value + ": " + kv.Key + " → " + materials[kv.Value]);
    }

    static string MaterialJson(Material mat, bool hasUv)
    {
        Color c = Color.white;
        Texture tex = null;
        if (mat != null)
        {
            if (mat.HasProperty("_BaseColor")) c = mat.GetColor("_BaseColor");
            else if (mat.HasProperty("_Color")) c = mat.GetColor("_Color");
            if (mat.HasProperty("_BaseMap")) tex = mat.GetTexture("_BaseMap");
            if (tex == null) tex = mat.mainTexture;
        }
        var sb = new StringBuilder();
        sb.Append("{\"name\":\"").Append(mat != null ? mat.name.Replace("\"", "") : "default").Append("\",");
        sb.Append("\"pbrMetallicRoughness\":{\"baseColorFactor\":[")
          .Append(F(c.linear.r)).Append(',').Append(F(c.linear.g)).Append(',').Append(F(c.linear.b)).Append(",1]");
        // The FBX's material search never finds the textures (they live in Part3/), so Unity
        // shows it untextured; the web build applies the Part3 diffuse to every UV'd material.
        if (hasUv) sb.Append(",\"baseColorTexture\":{\"index\":0}");
        sb.Append(",\"metallicFactor\":0,\"roughnessFactor\":0.9}");
        if (tex != null) sb.Append(",\"extras\":{\"unityTexture\":\"").Append(AssetDatabase.GetAssetPath(tex)).Append("\"}");
        sb.Append('}');
        return sb.ToString();
    }

    static int AddAccessor(MemoryStream bin, List<string> views, List<string> accs, float[] data, int count, string type, int target, string minMax)
    {
        Pad(bin);
        long offset = bin.Length;
        var bytes = new byte[data.Length * 4];
        Buffer.BlockCopy(data, 0, bytes, 0, bytes.Length);
        bin.Write(bytes, 0, bytes.Length);
        views.Add("{\"buffer\":0,\"byteOffset\":" + offset + ",\"byteLength\":" + bytes.Length + ",\"target\":" + target + "}");
        accs.Add("{\"bufferView\":" + (views.Count - 1) + ",\"componentType\":5126,\"count\":" + count + ",\"type\":\"" + type + "\"" + (minMax != null ? "," + minMax : "") + "}");
        return accs.Count - 1;
    }

    static int AddIndexAccessor(MemoryStream bin, List<string> views, List<string> accs, uint[] idx)
    {
        Pad(bin);
        long offset = bin.Length;
        var bytes = new byte[idx.Length * 4];
        Buffer.BlockCopy(idx, 0, bytes, 0, bytes.Length);
        bin.Write(bytes, 0, bytes.Length);
        views.Add("{\"buffer\":0,\"byteOffset\":" + offset + ",\"byteLength\":" + bytes.Length + ",\"target\":34963}");
        accs.Add("{\"bufferView\":" + (views.Count - 1) + ",\"componentType\":5125,\"count\":" + idx.Length + ",\"type\":\"SCALAR\"}");
        return accs.Count - 1;
    }

    static void Pad(MemoryStream s) { while (s.Length % 4 != 0) s.WriteByte(0); }

    static void WriteGlb(string path, string json, byte[] bin)
    {
        byte[] j = Encoding.UTF8.GetBytes(json);
        int jLen = (j.Length + 3) & ~3, bLen = (bin.Length + 3) & ~3;
        using (var w = new BinaryWriter(File.Create(path)))
        {
            w.Write(0x46546C67u); w.Write(2u); w.Write((uint)(12 + 8 + jLen + 8 + bLen));
            w.Write((uint)jLen); w.Write(0x4E4F534Au); w.Write(j);
            for (int i = j.Length; i < jLen; i++) w.Write((byte)0x20);
            w.Write((uint)bLen); w.Write(0x004E4942u); w.Write(bin);
            for (int i = bin.Length; i < bLen; i++) w.Write((byte)0);
        }
    }
}
