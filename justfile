# OpenSearch Dashboards -- Just Commands
#
# Install `just` first:  brew install just
# Run `just` (or `just default`) to list all recipes.

default:
    @just --list

fmt:
    node scripts/precommit_hook --fix

check:
    node scripts/precommit_hook --fix
    yarn typecheck

# TZ=UTC: these suites (query_enhancements formatDate, explore data_transformation
# pivot/aggregate) hard-code UTC-formatted expectations. CI runs in UTC; pinning it
# here keeps `just test`/`just all` green on machines in non-UTC local timezones.
test *args:
    TZ=UTC yarn test:jest {{args}}

test-file file:
    TZ=UTC yarn test:jest {{file}} --no-coverage

integ:
    TZ=UTC yarn test:jest_integration

run *args:
    yarn start --no-base-path {{args}}

build:
    yarn osd bootstrap

all:
    node scripts/precommit_hook --fix
    yarn typecheck
    TZ=UTC yarn test:jest --no-coverage

clean:
    yarn osd clean

bootstrap:
    yarn osd bootstrap

cypress *args:
    yarn cypress:run-without-security {{args}}

api-changes:
    yarn docs:acceptApiChanges
