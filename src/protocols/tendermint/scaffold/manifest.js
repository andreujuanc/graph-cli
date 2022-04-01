const source = () => `
      startBlock: 9200001`

const mapping = () => `
      apiVersion: 0.0.5
      language: wasm/assemblyscript
      entities:
        - ExampleEntity
      blockHandlers:
        - handler: handleBlock
      file: ./src/mapping.ts`

module.exports = {
  source,
  mapping,
}
