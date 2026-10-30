import json
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile


AUDIO_SETUP = '''
        do {
            let sonaAudioSession = AVAudioSession.sharedInstance()
            try sonaAudioSession.setCategory(.playback, mode: .default, options: [])
            try sonaAudioSession.setActive(true)
        } catch {
            NSLog("Sona audio session setup failed: %@", String(describing: error))
        }
'''


def patch_app_delegate(path):
    source = path.read_text(encoding="utf-8")
    if "let sonaAudioSession =" in source:
        if AUDIO_SETUP not in source or "import AVFoundation" not in source:
            raise RuntimeError("AppDelegate 中存在不完整的音频补丁，停止构建")
        return

    pattern = r"(func application\([^{}]*\bdidFinishLaunchingWithOptions\b[^{}]*\)\s*->\s*Bool\s*\{)"
    matches = list(re.finditer(pattern, source))
    if len(matches) != 1:
        raise RuntimeError("无法唯一定位 didFinishLaunchingWithOptions，模板可能已变化")

    insertion = matches[0].end()
    source = source[:insertion] + AUDIO_SETUP + source[insertion:]
    if "import AVFoundation" not in source:
        source = "import AVFoundation\n" + source
    path.write_text(source, encoding="utf-8")


def patch_info_plist(path):
    command = ["/usr/libexec/PlistBuddy"]

    def execute(operation):
        subprocess.run(command + ["-c", operation, str(path)], check=True)

    with path.open("rb") as handle:
        original = plistlib.load(handle)
    if "UIBackgroundModes" in original:
        execute("Delete :UIBackgroundModes")
    execute("Add :UIBackgroundModes array")
    execute("Add :UIBackgroundModes:0 string audio")
    if "CFBundleDisplayName" in original:
        execute("Set :CFBundleDisplayName 灵听")
    else:
        execute("Add :CFBundleDisplayName string 灵听")

    with path.open("rb") as handle:
        updated = plistlib.load(handle)
    assert updated["UIBackgroundModes"] == ["audio"]
    assert updated["CFBundleDisplayName"] == "灵听"


def generate_app_icon(assets_dir, public_dir):
    # 优先使用按当前网页 logo（public/icon.svg）渲染的 1024 图标
    preferred = Path(__file__).resolve().parent.parent / "assets" / "AppIcon-1024.png"
    candidates = ["apple-touch-icon.png", "icon-app.png", "icon.png"]
    source = preferred if preferred.is_file() else next((public_dir / name for name in candidates if (public_dir / name).is_file()), None)
    if source is None:
        print("::warning::未找到现有 PNG 图标，保留 Capacitor 默认图标")
        return

    assets_dir.mkdir(parents=True, exist_ok=True)
    destination = assets_dir / "Sona-1024.png"
    with tempfile.TemporaryDirectory() as temporary:
        properties = subprocess.check_output(["sips", "-g", "hasAlpha", str(source)], text=True)
        if "hasAlpha: yes" in properties:
            flattened = Path(temporary) / "icon.jpg"
            subprocess.run(["sips", "-s", "format", "jpeg", str(source), "--out", str(flattened)], check=True)
            source = flattened
        subprocess.run([
            "sips", "-s", "format", "png", "-z", "1024", "1024",
            str(source), "--out", str(destination),
        ], check=True)

    contents = {
        "images": [{"filename": destination.name, "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
        "info": {"author": "xcode", "version": 1},
    }
    (assets_dir / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n", encoding="utf-8")
    print(f"AppIcon 已生成：{destination}")


def main():
    shell_dir = Path(__file__).resolve().parents[1]
    app_dir = shell_dir / "ios" / "App" / "App"
    patch_app_delegate(app_dir / "AppDelegate.swift")
    patch_info_plist(app_dir / "Info.plist")
    generate_app_icon(app_dir / "Assets.xcassets" / "AppIcon.appiconset", shell_dir.parent / "public")


if __name__ == "__main__":
    main()
