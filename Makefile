.PHONY: dev build start deploy lint fix test test-watch test-e2e clean install

dev:
	npm run dev

build:
	npm run build

start:
	npm start

deploy:
	npm run deploy-commands

lint:
	npm run lint

fix:
	npm run lint:fix

test:
	npm test

test-watch:
	npm run test:watch

test-e2e:
	npm run test:e2e

clean:
	rm -rf dist

install:
	npm install
