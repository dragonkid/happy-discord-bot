.PHONY: dev build start deploy lint fix test test-watch test-e2e clean deps install publish

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

deps:
	npm install

install:
	npm run build && npm install -g .

publish:
	npm publish
