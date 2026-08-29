# Expand path patterns like **/*.ui
set shell := ['bash', '-O', 'globstar', '-c']

buildDir := './_build'
uuid := 'rounded-windows-lite@matheus-inacio'

# Compile the extension and all resources
build: clean
  # Compile TypeScript
  npm install
  npx tsc --outDir {{buildDir}}

  # Inject empty lines before JSDoc blocks OR before exports/functions
  # (but ONLY if they aren't already preceded by a comment or a blank line, and ignore line 1)
  awk -i inplace 'FNR > 1 && /^\/\*\*/ && prev !~ /^$/ { print "" } FNR > 1 && /^(export|function|const)/ && prev !~ /\*\/[[:space:]]*$/ && prev !~ /^$/ { print "" } { print; prev=$0 }' {{buildDir}}/**/*.js

  # Remove type-only JS files that compile to empty 'export {}' stubs (EGO-P-007)
  grep -rlx 'export {};' {{buildDir}} --include='*.js' | xargs -r rm -f

  # Copy non-JS files
  cp -r ./resources/* {{buildDir}}
  for file in $(find src -type f ! -name "*.ts" ! -name "*.md" -printf '%P\n'); do \
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