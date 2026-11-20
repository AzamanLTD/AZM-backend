# §WP-H §8 — one documented command for the complete suite.
.PHONY: test-full test-full-tls tls-certs docker-down docker-build

test-full:
	./scripts/test-full.sh

test-full-tls: tls-certs
	AZM_TEST_REDIS_TLS=1 ./scripts/test-full.sh

tls-certs:
	./scripts/gen-test-tls.sh

docker-build:
	docker compose --profile api build

docker-down:
	docker compose --profile api --profile tls down -v
