let fs = require('fs-extra')
let immutable = require('immutable')
let path = require('path')
let yaml = require('js-yaml')
let graphql = require('graphql/language')
let validation = require('./validation')
let ABI = require('./abi')

const throwCombinedError = (filename, errors) => {
  throw new Error(
    errors.reduce(
      (msg, e) =>
        `${msg}

  Path: ${e.get('path').size === 0 ? '/' : e.get('path').join(' > ')}
  ${e.get('message')}`,
      `Error in ${filename}:`
    )
  )
}

module.exports = class Subgraph {
  static validate(data, { resolveFile }) {
    // Parse the default subgraph schema
    let schema = graphql.parse(
      fs.readFileSync(path.join(__dirname, '..', 'manifest-schema.graphql'), 'utf-8')
    )

    // Obtain the root `SubgraphManifest` type from the schema
    let rootType = schema.definitions.find(definition => {
      return definition.name.value === 'SubgraphManifest'
    })

    // Validate the subgraph manifest using this schema
    return validation.validateManifest(data, rootType, schema, { resolveFile })
  }

  static validateSchema(manifest, { resolveFile }) {
    let filename = resolveFile(manifest.getIn(['schema', 'file']))
    let errors = validation.validateSchema(filename)
    if (errors.size > 0) {
      throw new Error(
        errors.reduce(
          (msg, e) => `${msg}

  ${e.get('message')}`,
          `Error in ${filename}:`
        )
      )
    }
  }

  static validateAbis(manifest, { resolveFile }) {
    // Validate that the the "source > abi" reference of all data sources
    // points to an existing ABI in the data source ABIs
    let abiReferenceErrors = manifest
      .get('dataSources')
      .filter(dataSource => dataSource.get('kind') === 'ethereum/contract')
      .reduce((errors, dataSource, dataSourceIndex) => {
        let abiName = dataSource.getIn(['source', 'abi'])
        let abiNames = dataSource.getIn(['mapping', 'abis']).map(abi => abi.get('name'))

        if (abiNames.includes(abiName)) {
          return errors
        } else {
          return errors.push(
            immutable.fromJS({
              path: ['dataSources', dataSourceIndex, 'source', 'abi'],
              message: `\
ABI name '${abiName}' not found in mapping > abis.
  Available ABIs:
  ${abiNames
    .sort()
    .map(name => `- ${name}`)
    .join('\n  ')}`,
            })
          )
        }
      }, immutable.List())

    // Validate that all ABI files are valid
    let abiFileErrors = manifest
      .get('dataSources')
      .filter(dataSource => dataSource.get('kind') === 'ethereum/contract')
      .reduce(
        (errors, dataSource, dataSourceIndex) =>
          dataSource.getIn(['mapping', 'abis']).reduce((errors, abi, abiIndex) => {
            try {
              ABI.load(abi.get('name'), resolveFile(abi.get('file')))
              return errors
            } catch (e) {
              return errors.push(
                immutable.fromJS({
                  path: [
                    'dataSources',
                    dataSourceIndex,
                    'mapping',
                    'abis',
                    abiIndex,
                    'file',
                  ],
                  message: e.message,
                })
              )
            }
          }, errors),
        immutable.List()
      )

    return immutable.List.of(...abiReferenceErrors, ...abiFileErrors)
  }

  static validateContractAddresses(manifest) {
    return manifest
      .get('dataSources')
      .filter(dataSource => dataSource.get('kind') === 'ethereum/contract')
      .reduce((errors, dataSource, dataSourceIndex) => {
        let path = ['dataSources', dataSourceIndex, 'source', 'address']
        let address = dataSource.getIn(['source', 'address'])

        // Validate whether the address is valid
        let pattern = /^(0x)?[0-9a-fA-F]{40}$/
        if (pattern.test(address)) {
          return errors
        } else {
          return errors.push(
            immutable.fromJS({
              path,
              message: `\
Contract address is invalid: ${address}
  Must be 40 hexadecimal characters, with an optional '0x' prefix.`,
            })
          )
        }
      }, immutable.List())
  }

  static validateEvents(manifest, { resolveFile }) {
    return manifest
      .get('dataSources')
      .filter(dataSource => dataSource.get('kind') === 'ethereum/contract')
      .reduce((errors, dataSource, dataSourceIndex) => {
        let path = ['dataSources', dataSourceIndex, 'eventHandlers']

        try {
          // Resolve the source ABI name into a real ABI object
          let abiName = dataSource.getIn(['source', 'abi'])
          let abiEntry = dataSource
            .getIn(['mapping', 'abis'])
            .find(abi => abi.get('name') === abiName)
          let abi = ABI.load(abiEntry.get('name'), resolveFile(abiEntry.get('file')))

          // Obtain event signatures from the mapping
          let manifestEvents = dataSource
            .getIn(['mapping', 'eventHandlers'])
            .map(handler => handler.get('event'))

          // Obtain event signatures from the ABI
          let abiEvents = abi.eventSignatures()

          // Add errors for every manifest event signature that is not
          // present in the ABI
          return manifestEvents.reduce(
            (errors, manifestEvent, index) =>
              abiEvents.includes(manifestEvent)
                ? errors
                : errors.push(
                    immutable.fromJS({
                      path: [...path, index],
                      message: `\
Event with signature '${manifestEvent}' not present in ABI '${abi.name}'.
  Available events:
  ${abiEvents
    .sort()
    .map(event => `- ${event}`)
    .join('\n  ')}`,
                    })
                  ),
            errors
          )
        } catch (e) {
          // Ignore errors silently; we can't really say anything about
          // the events if the ABI can't even be loaded
          return errors
        }
      }, immutable.List())
  }

  static load(filename) {
    // Load and validate the manifest
    let data = yaml.safeLoad(fs.readFileSync(filename, 'utf-8'))

    // Helper to resolve files relative to the subgraph manifest
    let resolveFile = maybeRelativeFile =>
      path.resolve(path.dirname(filename), maybeRelativeFile)

    let manifestErrors = Subgraph.validate(data, { resolveFile })
    if (manifestErrors.size > 0) {
      throwCombinedError(filename, manifestErrors)
    }

    let manifest = immutable.fromJS(data)

    // Validate the schema
    Subgraph.validateSchema(manifest, { resolveFile })

    // Perform other validations
    let errors = immutable.List.of(
      ...Subgraph.validateAbis(manifest, { resolveFile }),
      ...Subgraph.validateContractAddresses(manifest),
      ...Subgraph.validateEvents(manifest, { resolveFile })
    )

    if (errors.size > 0) {
      throwCombinedError(filename, errors)
    }

    return manifest
  }

  static write(subgraph, filename) {
    fs.writeFileSync(filename, yaml.safeDump(subgraph.toJS(), { indent: 2 }))
  }
}
