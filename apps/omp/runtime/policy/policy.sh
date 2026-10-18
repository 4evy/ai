# Package and repository launchers own runtime updates
if [ "${1-}" = update ]; then
  omp_readonly_update=false
  for omp_argument in "$@"; do
    case "$omp_argument" in
    --check | -c | --plugins | -l | --help | -h) omp_readonly_update=true ;;
    esac
  done
  if ! "$omp_readonly_update"; then
    printf '%s\n' \
      'This OMP runtime is pinned by AI tools; runtime self-updates are disabled.' \
      'Update the source pin with just omp update VERSION, then launch OMP again.' \
      'Use omp update --check to check releases or omp update --plugins for plugins.' >&2
    exit 1
  fi
  unset omp_readonly_update omp_argument
fi
