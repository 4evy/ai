set +x
set +v
unset BASH_ENV ENV
@BOUNDED@
bounded @SECONDS@ @BASH@ --noprofile --norc -c @COMMAND@ </dev/null
exit $?
