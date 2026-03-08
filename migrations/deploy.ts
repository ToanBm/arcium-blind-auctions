const anchor = require("@coral-xyz/anchor");

module.exports = async function (provider: typeof anchor.AnchorProvider) {
  anchor.setProvider(provider);
};
