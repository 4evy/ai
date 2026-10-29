set -euo pipefail

dependencies=$1
modules=$2
mkdir -p "$modules"
for package in "$dependencies"/node_modules/*; do
  [ -e "$package" ] || continue
  name=$(basename "$package")
  case "$name" in
  @*)
    mkdir -p "$modules/$name"
    for scoped in "$package"/*; do
      [ -e "$scoped" ] || continue
      ln -s "$scoped" "$modules/$name/$(basename "$scoped")"
    done
    ;;
  *) ln -s "$package" "$modules/$name" ;;
  esac
done
if [ -d "$dependencies/node_modules/.bin" ]; then
  mkdir -p "$modules/.bin"
  for executable in "$dependencies"/node_modules/.bin/*; do
    [ -e "$executable" ] || continue
    ln -s "$executable" "$modules/.bin/$(basename "$executable")"
  done
fi
