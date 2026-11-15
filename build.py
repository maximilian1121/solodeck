import json
import os
import shutil
import subprocess
import sys
import time
import tempfile
import zipfile

# 1. Clean up only the old dist folder (leaving node_modules completely alone)
shutil.rmtree('dist', ignore_errors=True)

# 2. Run the Decky frontend compiler
subprocess.run(['pnpm', 'build'], check=True)

# 2b. Install spotapi into ./py_modules at build time only.
#     Wheels are fetched for manylinux2014_x86_64 / Python 3.11 so the libs
#     are bundled into the plugin zip instead of being pulled at runtime.
subprocess.run([
    sys.executable, '-m', 'pip', 'install',
    'spotapi==2.1.0', 'playwright==1.55.0', 'greenlet==3.2.4',
    'cryptography==46.0.5', 'cffi==2.1.1',
    '--target=./py_modules',
    '--upgrade',
    '--platform=manylinux2014_x86_64',
    '--python-version=3.11',
    '--only-binary=:all:',
], check=True)

# Decky ships its own Python interpreter, whose version can differ between
# releases. Ship matching greenlet extensions for Python 3.11 through 3.14;
# the interpreter selects its own ABI-tagged module at import time.
with tempfile.TemporaryDirectory(prefix='solodeck-greenlet-') as wheel_dir:
    for minor in (12, 13, 14):
        version = f'3.{minor}'
        abi = f'cp3{minor}'
        subprocess.run([
            sys.executable, '-m', 'pip', 'download', '--no-deps',
            'greenlet==3.2.4', '--dest', wheel_dir,
            '--platform', 'manylinux2014_x86_64', '--python-version', version,
            '--implementation', 'cp', '--abi', abi, '--only-binary=:all:',
        ], check=True)
        wheels = [name for name in os.listdir(wheel_dir)
                  if name.startswith(f'greenlet-3.2.4-{abi}-') and name.endswith('.whl')]
        if len(wheels) != 1:
            raise RuntimeError(f'Expected one greenlet wheel for Python {version}')
        with zipfile.ZipFile(os.path.join(wheel_dir, wheels[0])) as wheel:
            binaries = [name for name in wheel.namelist()
                        if name.startswith(f'greenlet/_greenlet.cpython-3{minor}-')
                        and name.endswith('.so') and '/' not in name[len('greenlet/'):]]
            if len(binaries) != 1:
                raise RuntimeError(f'Missing greenlet extension for Python {version}')
            with wheel.open(binaries[0]) as source, open(os.path.join('py_modules', binaries[0]), 'wb') as destination:
                shutil.copyfileobj(source, destination)

# cryptography also uses an ABI-specific CFFI module on supported interpreters.
with tempfile.TemporaryDirectory(prefix='solodeck-cffi-') as wheel_dir:
    for minor in (12, 13, 14):
        version = f'3.{minor}'
        abi = f'cp3{minor}'
        subprocess.run([
            sys.executable, '-m', 'pip', 'download', '--no-deps',
            'cffi==2.1.1', '--dest', wheel_dir,
            '--platform', 'manylinux2014_x86_64', '--python-version', version,
            '--implementation', 'cp', '--abi', abi, '--only-binary=:all:',
        ], check=True)
        wheels = [name for name in os.listdir(wheel_dir)
                  if name.startswith(f'cffi-2.1.1-{abi}-') and name.endswith('.whl')]
        if len(wheels) != 1:
            raise RuntimeError(f'Expected one CFFI wheel for Python {version}')
        with zipfile.ZipFile(os.path.join(wheel_dir, wheels[0])) as wheel:
            binaries = [name for name in wheel.namelist()
                        if name.startswith(f'_cffi_backend.cpython-3{minor}-')
                        and name.endswith('.so') and '/' not in name]
            if len(binaries) != 1:
                raise RuntimeError(f'Missing CFFI extension for Python {version}')
            with wheel.open(binaries[0]) as source, open(os.path.join('py_modules', binaries[0]), 'wb') as destination:
                shutil.copyfileobj(source, destination)

# Fetch the browser at build time, not on the user's Deck.  Running Playwright's
# packaged Node CLI directly avoids importing its Python 3.11 native dependency
# on build hosts which use a different Python version. The full Chromium build
# is needed for interactive login; the headless shell would be wasted space.
browser_cache = os.path.abspath(os.path.join('.build', 'browsers'))
playwright_driver = os.path.abspath(os.path.join('py_modules', 'playwright', 'driver'))
browser_env = os.environ.copy()
browser_env['PLAYWRIGHT_BROWSERS_PATH'] = browser_cache
subprocess.run([
    os.path.join(playwright_driver, 'node'),
    os.path.join(playwright_driver, 'package', 'cli.js'),
    'install', 'chromium', '--no-shell',
], env=browser_env, check=True)

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
        'package.json', 'plugin.json', 'main.py', 'spotapi_adapter.py', 'spotapi_playback.py', 'spotapi_browser_login.py', 'spotify_password_store.py', 'README.md', 'LICENSE', 'LICENSE.md'
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
    for folder in ['dist', 'py_modules', 'vendor/python-stdlib']:
        if os.path.exists(folder):
            for dirpath, dirnames, filenames in os.walk(folder):
                dirnames[:] = [name for name in dirnames if name != '__pycache__']
                for filename in filenames:
                    full_path = os.path.join(dirpath, filename)
                    relative_path = os.path.relpath(full_path, start=".")
                    archive_name = os.path.join(plugin_name, relative_path)
                    file.write(full_path, arcname=archive_name, compress_type=zipfile.ZIP_DEFLATED)

    # Bundle only the interactive Chromium and its associated ffmpeg binary.
    # file.write preserves Unix executable permission bits in the zip metadata.
    with open(os.path.join(playwright_driver, 'package', 'browsers.json'), encoding='utf-8') as manifest_file:
        manifest = json.load(manifest_file)
    revisions = {item['name']: item['revision'] for item in manifest['browsers']}
    entries = [f"{name}-{revisions[name]}" for name in ('chromium', 'ffmpeg')]
    for entry in entries:
        root = os.path.join(browser_cache, entry)
        if not os.path.isdir(root):
            raise RuntimeError(f'Missing browser runtime: {root}')
        for dirpath, dirnames, filenames in os.walk(root):
            for filename in filenames:
                full_path = os.path.join(dirpath, filename)
                relative_path = os.path.relpath(full_path, browser_cache)
                archive_name = os.path.join(plugin_name, 'playwright-browsers', relative_path)
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
