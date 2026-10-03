# Hello-world stand-in for the hub (deploy chain test).
FROM node:26-alpine
ARG COMMIT=unknown
ENV COMMIT=$COMMIT
WORKDIR /app
COPY server.mjs .
USER node
EXPOSE 8790
CMD ["node", "server.mjs"]
