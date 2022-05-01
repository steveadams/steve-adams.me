# base node image
FROM node:16-bullseye-slim as base

# set for base and all layer that inherit from it
ENV NODE_ENV production

# Install all node_modules, including dev dependencies
FROM base as deps

WORKDIR /steve-adams.me

ADD package.json package-lock.json ./
RUN npm install --production=false

# Setup production node_modules
FROM base as production-deps

WORKDIR /steve-adams.me

COPY --from=deps /steve-adams.me/node_modules /steve-adams.me/node_modules
ADD package.json package-lock.json ./
RUN npm prune --production

# Build the app
FROM base as build

WORKDIR /steve-adams.me

COPY --from=deps /steve-adams.me/node_modules /steve-adams.me/node_modules

ADD . .
RUN npm run build

# Finally, build the production image with minimal footprint
FROM base

ENV PORT="8080"
ENV NODE_ENV="production"

WORKDIR /steve-adams.me

COPY --from=production-deps /steve-adams.me/node_modules /steve-adams.me/node_modules

COPY --from=build /steve-adams.me/build /steve-adams.me/build
COPY --from=build /steve-adams.me/public /steve-adams.me/public
ADD . .

CMD ["npm", "start"]
