# Expand path patterns like **/*.ui
set shell := ['bash', '-O', 'globstar', '-c']

buildDir := './_build'
uuid := 'rounded-windows-lite@matheus-inacio'

# Compile the extension and all resources
build: clean
  # Compile TypeScript
  npm install
  npx tsc --outDir {{buildDir}}

  # Copy non-JS files
  cp -r ./resources/* {{buildDir}}
  for file in $(find src -type f ! -name "*.ts" -printf '%P\n'); do \
    path={{buildDir}}/$(dirname $file); \
    mkdir -p $path; \
    cp src/$file $path; \
  done;

# Build and install the extension from source
install: build
  rm -rf ~/.local/share/gnome-shell/extensions/{{uuid}}
  cp -r {{buildDir}} ~/.local/share/gnome-shell/extensions/{{uuid}}

# Build and pack the extension
pack: build
  cd {{buildDir}} && zip -9r ../{{uuid}}.shell-extension.zip .

# Delete the build directory
clean:
  rm -rf {{buildDir}} {{uuid}}.shell-extension.zip