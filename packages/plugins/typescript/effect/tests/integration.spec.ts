import * as path from 'node:path';
import * as fs from 'fs-extra';
import { parse } from 'graphql';
import { codegen } from '@graphql-codegen/core';
import { mockGraphQLServer } from '@graphql-codegen/testing';
import * as TypeScriptPlugin from '@graphql-codegen/typescript';
import * as TypeScriptOperationsPlugin from '@graphql-codegen/typescript-operations';
import { makeExecutableSchema } from '@graphql-tools/schema';
import * as EffectPlugin from '../src/index.js';

describe('Effect Integration', () => {
  it('should send requests correctly', async () => {
    const sdkFileName = 'effect-sdk.ts';
    const sdkFilePath = path.join(__dirname, './test-files', sdkFileName);
    const typeDefs = parse(/* GraphQL */ `
      type Query {
        add(x: Int!, y: Int!): Int!
      }
    `);
    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        Query: {
          add: (_, { x, y }) => x + y,
        },
      },
    });
    const exampleQuery = /* GraphQL */ `
      query Add($x: Int!, $y: Int!) {
        add(x: $x, y: $y)
      }
    `;
    const sdkCodeString = await codegen({
      schema: typeDefs,
      schemaAst: schema,
      documents: [
        {
          document: parse(exampleQuery),
          rawSDL: exampleQuery,
        },
      ],
      filename: sdkFileName,
      pluginMap: {
        typescript: TypeScriptPlugin,
        'typescript-operations': TypeScriptOperationsPlugin,
        effect: EffectPlugin,
      },
      plugins: [
        {
          typescript: {},
        },
        {
          'typescript-operations': {},
        },
        {
          effect: {},
        },
      ],
      config: {},
    });
    await fs.writeFile(sdkFilePath, sdkCodeString, 'utf-8');
    const mockServer = mockGraphQLServer({
      schema,
      host: 'http://localhost:4000',
      path: '/graphql',
    });
    const { runExampleQuery } = require('./test-files/run-example-query');
    const { body } = await runExampleQuery(2, 3);
    expect(body.data.add).toBe(5);
    mockServer.done();
    await fs.remove(sdkFilePath);
  });
});
