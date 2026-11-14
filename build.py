import json
import os
import shutil
import subprocess
import sys
import time
import zipfile

# 1. Clean up only the old dist folder (leaving node_modules completely alone)
shutil.rmtree('dist', ignore_errors=True)

# 2. Run the Decky frontend compiler
subprocess.run(['pnpm', 'build'], check=True)

# 3. Safely extract metadata (name & version) for zip naming
plugin_name = "solodeck"
plugin_base_version = "1.0"

if os.path.exists("plugin.json"):
    try:
        with open("plugin.json", "r") as f:
            metadata = json.load(f)
            plugin_name = metadata.get("name", plugin_name)
    except Exception as e:
        print(f"Warning: Could not parse plugin.json for naming: {e}")

# Decky Loader reads the plugin version from package.json
package_metadata = {}
if os.path.exists("package.json"):
    try:
        with open("package.json", "r") as f:
            package_metadata = json.load(f)
            plugin_base_version = package_metadata.get("version", plugin_base_version)
    except Exception as e:
        print(f"Warning: Could not parse package.json for naming: {e}")

# The plugin version is just the package version (e.g. "1.0").
# soloist is NOT bundled and NOT versioned here: it is downloaded at runtime
# by the plugin itself, so the plugin build number never depends on soloist.
plugin_version = plugin_base_version

# Record when this build was created.
build_time = int(time.time())

# Format zip name to: pluginname-vX.Y.Z.zip
zip_filename = f"{plugin_name}-v{plugin_version}.zip"

print(f"Plugin version: {plugin_version}")
print(f"Build time: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(build_time))}")
print("(soloist is downloaded at runtime and is NOT included in this zip)")

with zipfile.ZipFile(zip_filename, "w") as file:

    # 4. Pack config files INSIDE the pluginname directory.
    #    Decky Loader requires every file (plugin.json included) to live under a
    #    single top-level folder inside the zip, e.g. "solodeck/plugin.json".
    #    This mirrors the layout produced by the official decky CLI.
    files_needed = [
        'package.json', 'plugin.json', 'main.py', 'README.md', 'LICENSE', 'LICENSE.md'
    ]
    for filename in files_needed:
        if not os.path.exists(filename):
            continue
        archive_name = os.path.join(plugin_name, filename)
        if filename == 'package.json':
            # Bake the plugin version and the build time into the packaged file
            package_metadata["version"] = plugin_version
            package_metadata["build_time"] = build_time
            file.writestr(archive_name, json.dumps(package_metadata, indent=2) + "\n",
                          compress_type=zipfile.ZIP_DEFLATED)
        else:
            file.write(filename, arcname=archive_name, compress_type=zipfile.ZIP_DEFLATED)

    # 5. Pack the 'dist/' and 'py_modules/' folder structures INSIDE the
    #    pluginname/ directory. Note: there is no 'bin/' anymore because
    #    soloist is not bundled.
    for folder in ['dist', 'py_modules']:
        if os.path.exists(folder):
            for dirpath, dirnames, filenames in os.walk(folder):
                for filename in filenames:
                    full_path = os.path.join(dirpath, filename)
                    relative_path = os.path.relpath(full_path, start=".")
                    archive_name = os.path.join(plugin_name, relative_path)
                    file.write(full_path, arcname=archive_name, compress_type=zipfile.ZIP_DEFLATED)

    # 6. Pack the contents of the 'defaults/' folder at the root of the plugin
    #    (e.g. "defaults/themes/foo.css" ends up as "pluginname/themes/foo.css",
    #    matching the official decky CLI behaviour)
    if os.path.exists('defaults'):
        for dirpath, dirnames, filenames in os.walk('defaults'):
            for filename in filenames:
                full_path = os.path.join(dirpath, filename)
                relative_path = os.path.relpath(full_path, start="defaults")
                archive_name = os.path.join(plugin_name, relative_path)
                file.write(full_path, arcname=archive_name, compress_type=zipfile.ZIP_DEFLATED)

print(f"Successfully generated a matching layout package: {zip_filename}")
