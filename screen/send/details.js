/* global alert */
import React, { Component } from 'react';
import {
  ActivityIndicator,
  Alert,
  View,
  TextInput,
  StatusBar,
  TouchableOpacity,
  KeyboardAvoidingView,
  Keyboard,
  TouchableWithoutFeedback,
  StyleSheet,
  Platform,
  InteractionManager,
  Text,
} from 'react-native';
import { Icon } from 'react-native-elements';
import {
  BlueNavigationStyle,
  BlueButton,
  BlueBitcoinAmount,
  BlueAddressInput,
  BlueDismissKeyboardInputAccessory,
  BlueLoading,
} from '../../BlueComponents';
import PropTypes from 'prop-types';
import Modal from 'react-native-modal';
import NetworkTransactionFees, { NetworkTransactionFeeStatus } from '../../models/networkTransactionFees';
import BitcoinBIP70TransactionDecode from '../../bip70/bip70';
import { BitcoinUnit, Chain } from '../../models/bitcoinUnits';
import { HDLegacyP2PKHWallet, HDSegwitBech32Wallet, HDSegwitP2SHWallet, LightningCustodianWallet } from '../../class';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import prompt from 'react-native-prompt-android';
const bip21 = require('bip21');
const BigNumber = require('bignumber.js');
/** @type {AppStorage} */
const BlueApp = require('../../BlueApp');
const loc = require('../../loc');
const bitcoin = require('bitcoinjs-lib');

const btcAddressRx = /^[a-zA-Z0-9]{26,35}$/;

export default class SendDetails extends Component {
  static navigationOptions = ({ navigation }) => ({
    ...BlueNavigationStyle(navigation, true),
    title: loc.send.header,
  });

  constructor(props) {
    super(props);
    let address;
    let memo;
    if (props.navigation.state.params) address = props.navigation.state.params.address;
    if (props.navigation.state.params) memo = props.navigation.state.params.memo;
    let fromAddress;
    if (props.navigation.state.params) fromAddress = props.navigation.state.params.fromAddress;
    let fromSecret;
    if (props.navigation.state.params) fromSecret = props.navigation.state.params.fromSecret;
    let fromWallet = null;
    if (props.navigation.state.params) fromWallet = props.navigation.state.params.fromWallet;

    const wallets = BlueApp.getWallets().filter(wallet => wallet.type !== LightningCustodianWallet.type);

    if (wallets.length === 0) {
      alert('Before creating a transaction, you must first add a Bitcoin wallet.');
      return props.navigation.goBack(null);
    } else {
      if (!fromWallet && wallets.length > 0) {
        fromWallet = wallets[0];
        fromAddress = fromWallet.getAddress();
        fromSecret = fromWallet.getSecret();
      }
      this.state = {
        isLoading: true,
        isFeeSelectionModalVisible: false,
        fromAddress,
        fromWallet,
        fromSecret,
        address,
        memo,
        amount: 0,
        fee: 1,
        isFeeCustom: true,
        feeFetchStatus: NetworkTransactionFeeStatus.INACTIVE,
        bip70TransactionExpiration: null,
        renderWalletSelectionButtonHidden: false,
        networkTransactionFees: undefined,
      };
    }
  }

  /**
   * TODO: refactor this mess, get rid of regexp, use https://github.com/bitcoinjs/bitcoinjs-lib/issues/890 etc etc
   *
   * @param data {String} Can be address or `bitcoin:xxxxxxx` uri scheme, or invalid garbage
   */
  processAddressData = data => {
    this.setState(
      { isLoading: true },
      () => {
        if (BitcoinBIP70TransactionDecode.matchesPaymentURL(data)) {
          this.processBIP70Invoice(data);
        } else {
          const dataWithoutSchema = data.replace('bitcoin:', '');
          if (btcAddressRx.test(dataWithoutSchema) || (dataWithoutSchema.indexOf('bc1') === 0 && dataWithoutSchema.indexOf('?') === -1)) {
            this.setState({
              address: dataWithoutSchema,
              bip70TransactionExpiration: null,
              isLoading: false,
            });
          } else {
            let address = '';
            let options;
            try {
              if (!data.toLowerCase().startsWith('bitcoin:')) {
                data = `bitcoin:${data}`;
              }
              const decoded = bip21.decode(data);
              address = decoded.address;
              options = decoded.options;
            } catch (error) {
              data = data.replace(/(amount)=([^&]+)/g, '').replace(/(amount)=([^&]+)&/g, '');
              const decoded = bip21.decode(data);
              decoded.options.amount = 0;
              address = decoded.address;
              options = decoded.options;
              this.setState({ isLoading: false });
            }
            console.log(options);
            if (btcAddressRx.test(address) || address.indexOf('bc1') === 0) {
              this.setState({
                address,
                amount: options.amount,
                memo: options.label || options.message,
                bip70TransactionExpiration: null,
                isLoading: false,
              });
            }
          }
        }
      },
      true,
    );
  };

  async componentDidMount() {
    console.log('send/details - componentDidMount');
    StatusBar.setBarStyle('dark-content');
    this.keyboardDidShowListener = Keyboard.addListener('keyboardDidShow', this._keyboardDidShow);
    this.keyboardDidHideListener = Keyboard.addListener('keyboardDidHide', this._keyboardDidHide);

    if (this.props.navigation.state.params.uri) {
      if (BitcoinBIP70TransactionDecode.matchesPaymentURL(this.props.navigation.state.params.uri)) {
        this.processBIP70Invoice(this.props.navigation.state.params.uri);
      } else {
        try {
          const { address, amount, memo } = this.decodeBitcoinUri(this.props.navigation.getParam('uri'));
          this.setState({ address, amount, memo, isLoading: false });
        } catch (error) {
          console.log(error);
          this.setState({ isLoading: false });
          alert('Error: Unable to decode Bitcoin address');
        }
      }
    } else {
      this.setState({ isLoading: false });
    }

    this.fetchNetworkFees();
  }

  componentWillUnmount() {
    this.keyboardDidShowListener.remove();
    this.keyboardDidHideListener.remove();
  }

  _keyboardDidShow = () => {
    this.setState({ renderWalletSelectionButtonHidden: true });
  };

  _keyboardDidHide = () => {
    this.setState({ renderWalletSelectionButtonHidden: false });
  };

  fetchNetworkFees = () => {
    this.setState({ feeFetchStatus: NetworkTransactionFeeStatus.FETCHING }, () =>
      InteractionManager.runAfterInteractions(async () => {
        try {
          const recommendedFees = await NetworkTransactionFees.recommendedFees();
          this.setState({
            fee: recommendedFees.fast,
            networkTransactionFees: recommendedFees,
            isFeeCustom: false,
            feeFetchStatus: NetworkTransactionFeeStatus.INACTIVE,
          });
        } catch (_e) {
          this.setState({
            feeFetchStatus: NetworkTransactionFeeStatus.FAILED,
          });
        }
      }),
    );
  };

  decodeBitcoinUri(uri) {
    let amount = '';
    let parsedBitcoinUri = null;
    let address = uri || '';
    let memo = '';
    try {
      parsedBitcoinUri = bip21.decode(uri);
      address = parsedBitcoinUri.hasOwnProperty('address') ? parsedBitcoinUri.address : address;
      if (parsedBitcoinUri.hasOwnProperty('options')) {
        if (parsedBitcoinUri.options.hasOwnProperty('amount')) {
          amount = parsedBitcoinUri.options.amount.toString();
          amount = parsedBitcoinUri.options.amount;
        }
        if (parsedBitcoinUri.options.hasOwnProperty('label')) {
          memo = parsedBitcoinUri.options.label || memo;
        }
      }
    } catch (_) {}
    return { address, amount, memo };
  }

  recalculateAvailableBalance(balance, amount, fee) {
    if (!amount) amount = 0;
    if (!fee) fee = 0;
    let availableBalance;
    try {
      availableBalance = new BigNumber(balance);
      availableBalance = availableBalance.div(100000000); // sat2btc
      availableBalance = availableBalance.minus(amount);
      availableBalance = availableBalance.minus(fee);
      availableBalance = availableBalance.toString(10);
    } catch (err) {
      return balance;
    }

    return (availableBalance === 'NaN' && balance) || availableBalance;
  }

  calculateFee(utxos, txhex, utxoIsInSatoshis) {
    let index = {};
    let c = 1;
    index[0] = 0;
    for (let utxo of utxos) {
      if (!utxoIsInSatoshis) {
        utxo.amount = new BigNumber(utxo.amount).multipliedBy(100000000).toNumber();
      }
      index[c] = utxo.amount + index[c - 1];
      c++;
    }

    let tx = bitcoin.Transaction.fromHex(txhex);
    let totalInput = index[tx.ins.length];
    // ^^^ dumb way to calculate total input. we assume that signer uses utxos sequentially
    // so total input == sum of yongest used inputs (and num of used inputs is `tx.ins.length`)
    // TODO: good candidate to refactor and move to appropriate class. some day

    let totalOutput = 0;
    for (let o of tx.outs) {
      totalOutput += o.value * 1;
    }

    return new BigNumber(totalInput - totalOutput).dividedBy(100000000).toNumber();
  }

  processBIP70Invoice(text) {
    try {
      if (BitcoinBIP70TransactionDecode.matchesPaymentURL(text)) {
        this.setState(
          {
            isLoading: true,
          },
          () => {
            Keyboard.dismiss();
            BitcoinBIP70TransactionDecode.decode(text)
              .then(response => {
                this.setState({
                  address: response.address,
                  amount: loc.formatBalanceWithoutSuffix(response.amount, BitcoinUnit.BTC, false),
                  memo: response.memo,
                  fee: response.fee,
                  isFeeCustom: true,
                  bip70TransactionExpiration: response.expires,
                  isLoading: false,
                });
              })
              .catch(error => {
                alert(error.errorMessage);
                this.setState({ isLoading: false, bip70TransactionExpiration: null, isFeeCustom: false });
              });
          },
        );
      }
      return true;
    } catch (error) {
      this.setState({ address: text.replace(' ', ''), isLoading: false, bip70TransactionExpiration: null, amount: 0, isFeeCustom: false });
      return false;
    }
  }

  async createTransaction() {
    Keyboard.dismiss();
    this.setState({ isLoading: true });
    let error = false;
    let requestedSatPerByte = this.state.fee.toString().replace(/\D/g, '');

    if (!this.state.amount || this.state.amount === '0' || parseFloat(this.state.amount) === 0) {
      error = loc.send.details.amount_field_is_not_valid;
      console.log('validation error');
    } else if (!this.state.fee || !requestedSatPerByte || parseFloat(requestedSatPerByte) < 1) {
      error = loc.send.details.fee_field_is_not_valid;
      console.log('validation error');
    } else if (!this.state.address) {
      error = loc.send.details.address_field_is_not_valid;
      console.log('validation error');
    } else if (this.recalculateAvailableBalance(this.state.fromWallet.getBalance(), this.state.amount, 0) < 0) {
      // first sanity check is that sending amount is not bigger than available balance
      error = loc.send.details.total_exceeds_balance;
      console.log('validation error');
    } else if (BitcoinBIP70TransactionDecode.isExpired(this.state.bip70TransactionExpiration)) {
      error = 'Transaction has expired.';
      console.log('validation error');
    } else if (this.state.address) {
      const address = this.state.address.trim().toLowerCase();
      if (address.startsWith('lnb') || address.startsWith('lightning:lnb')) {
        error =
          'This address appears to be for a Lightning invoice. Please, go to your Lightning wallet in order to make a payment for this invoice.';
        console.log('validation error');
      }
    }

    if (!error) {
      try {
        bitcoin.address.toOutputScript(this.state.address);
      } catch (err) {
        console.log('validation error');
        console.log(err);
        error = loc.send.details.address_field_is_not_valid;
      }
    }

    if (error) {
      this.setState({ isLoading: false });
      alert(error);
      ReactNativeHapticFeedback.trigger('notificationError', { ignoreAndroidSystemSettings: false });
      return;
    }

    if (this.state.fromWallet.type === HDSegwitBech32Wallet.type) {
      try {
        await this.createHDBech32Transaction();
      } catch (Err) {
        this.setState({ isLoading: false }, () => {
          alert(Err.message);
          ReactNativeHapticFeedback.trigger('notificationError', { ignoreAndroidSystemSettings: false });
        });
      }
      return;
    }

    // legacy send below

    this.setState({ isLoading: true }, async () => {
      let utxo;
      let actualSatoshiPerByte;
      let tx, txid;
      let tries = 1;
      let fee = 0.000001; // initial fee guess

      try {
        await this.state.fromWallet.fetchUtxo();
        if (this.state.fromWallet.getChangeAddressAsync) {
          await this.state.fromWallet.getChangeAddressAsync(); // to refresh internal pointer to next free address
        }
        if (this.state.fromWallet.getAddressAsync) {
          await this.state.fromWallet.getAddressAsync(); // to refresh internal pointer to next free address
        }

        utxo = this.state.fromWallet.utxo;

        do {
          console.log('try #', tries, 'fee=', fee);
          if (this.recalculateAvailableBalance(this.state.fromWallet.getBalance(), this.state.amount, fee) < 0) {
            // we could not add any fee. user is trying to send all he's got. that wont work
            throw new Error(loc.send.details.total_exceeds_balance);
          }

          let startTime = Date.now();
          tx = this.state.fromWallet.createTx(utxo, this.state.amount, fee, this.state.address, this.state.memo);
          let endTime = Date.now();
          console.log('create tx ', (endTime - startTime) / 1000, 'sec');

          let txDecoded = bitcoin.Transaction.fromHex(tx);
          txid = txDecoded.getId();
          console.log('txid', txid);
          console.log('txhex', tx);
          if (this.state.isFeeCustom) {
            let feeSatoshi = new BigNumber(fee).multipliedBy(100000000);
            actualSatoshiPerByte = feeSatoshi.dividedBy(Math.round(tx.length / 2));
            actualSatoshiPerByte = actualSatoshiPerByte.toNumber();
            console.log({ satoshiPerByte: actualSatoshiPerByte });

            if (Math.round(actualSatoshiPerByte) !== requestedSatPerByte * 1 || Math.floor(actualSatoshiPerByte) < 1) {
              console.log('fee is not correct, retrying');
              fee = feeSatoshi
                .multipliedBy(requestedSatPerByte / actualSatoshiPerByte)
                .plus(10)
                .dividedBy(100000000)
                .toNumber();
            } else {
              break;
            }
          }
        } while (tries++ < 5);

        BlueApp.tx_metadata = BlueApp.tx_metadata || {};
        BlueApp.tx_metadata[txid] = {
          txhex: tx,
          memo: this.state.memo,
        };
        await BlueApp.saveToDisk();
      } catch (err) {
        console.log(err);
        ReactNativeHapticFeedback.trigger('notificationError', { ignoreAndroidSystemSettings: false });
        alert(err);
        this.setState({ isLoading: false });
        return;
      }

      this.setState({ isLoading: false }, () =>
        this.props.navigation.navigate('Confirm', {
          amount: this.state.amount,
          // HD wallet's utxo is in sats, classic segwit wallet utxos are in btc
          fee: this.state.isFeeCustom
            ? this.calculateFee(
                utxo,
                tx,
                this.state.fromWallet.type === HDSegwitP2SHWallet.type || this.state.fromWallet.type === HDLegacyP2PKHWallet.type,
              )
            : this.state.fee,
          address: this.state.address,
          memo: this.state.memo,
          fromWallet: this.state.fromWallet,
          tx: tx,
          satoshiPerByte: this.state.isFeeCustom ? actualSatoshiPerByte.toFixed(2) : this.state.fee,
        }),
      );
    });
  }

  async createHDBech32Transaction() {
    /** @type {HDSegwitBech32Wallet} */
    const wallet = this.state.fromWallet;
    await wallet.fetchUtxo();
    const changeAddress = await wallet.getChangeAddressAsync();
    let satoshis = new BigNumber(this.state.amount).multipliedBy(100000000).toNumber();
    const requestedSatPerByte = +this.state.fee.toString().replace(/\D/g, '');
    console.log({ satoshis, requestedSatPerByte, utxo: wallet.getUtxo() });

    let targets = [];
    targets.push({ address: this.state.address, value: satoshis });

    let { tx, fee } = wallet.createTransaction(wallet.getUtxo(), targets, requestedSatPerByte, changeAddress);

    BlueApp.tx_metadata = BlueApp.tx_metadata || {};
    BlueApp.tx_metadata[tx.getId()] = {
      txhex: tx.toHex(),
      memo: this.state.memo,
    };
    await BlueApp.saveToDisk();

    this.setState({ isLoading: false }, () =>
      this.props.navigation.navigate('Confirm', {
        amount: this.state.amount,
        fee: new BigNumber(fee).dividedBy(100000000).toNumber(),
        address: this.state.address,
        memo: this.state.memo,
        fromWallet: wallet,
        tx: tx.toHex(),
        satoshiPerByte: requestedSatPerByte,
      }),
    );
  }

  onWalletSelect = wallet => {
    this.setState({ fromAddress: wallet.getAddress(), fromSecret: wallet.getSecret(), fromWallet: wallet }, () => {
      this.props.navigation.pop();
    });
  };

  feeText = () => {
    if (this.state.networkTransactionFees === undefined || this.state.isFeeCustom) {
      return `${this.state.fee} sat/b`;
    } else {
      return loc.formatBalance(parseInt(this.state.fee * 100000000).toFixed(0), this.state.fromWallet.preferredBalanceUnit, true);
    }
  };

  renderFeeSelectionModal = () => {
    if (typeof this.state.networkTransactionFees !== 'object') {
      return <React.Fragment />;
    } else {
      return (
        <Modal
          isVisible={this.state.isFeeSelectionModalVisible}
          style={styles.bottomModal}
          onBackdropPress={() => {
            Keyboard.dismiss();
            this.setState({ isFeeSelectionModalVisible: false });
          }}
        >
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'position' : null}>
            <View style={styles.modalContent}>
              <TouchableOpacity
                style={StyleSheet.flatten([
                  styles.feeRow,
                  { backgroundColor: this.state.fee === this.state.networkTransactionFees.fast ? '#d2f8d6' : '#FFFFFF' },
                ])}
                onPress={() =>
                  this.setState({ fee: this.state.networkTransactionFees.fast, isFeeCustom: false, isFeeSelectionModalVisible: false })
                }
              >
                <Text style={styles.feeText}>
                  {loc.formatBalance(
                    parseInt(this.state.networkTransactionFees.fast * 100000000).toFixed(0),
                    this.state.fromWallet.preferredBalanceUnit,
                    true,
                  )}
                </Text>
                <Text style={styles.feeTextReadable}>Fast</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={StyleSheet.flatten([
                  styles.feeRow,
                  { backgroundColor: this.state.fee === this.state.networkTransactionFees.medium ? '#d2f8d6' : '#FFFFFF' },
                ])}
                onPress={() =>
                  this.setState({ fee: this.state.networkTransactionFees.medium, isFeeCustom: false, isFeeSelectionModalVisible: false })
                }
              >
                <Text style={styles.feeText}>
                  {loc.formatBalance(
                    parseInt(this.state.networkTransactionFees.medium * 100000000).toFixed(0),
                    this.state.fromWallet.preferredBalanceUnit,
                    true,
                  )}
                </Text>
                <Text style={styles.feeTextReadable}>Medium</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={StyleSheet.flatten([
                  styles.feeRow,
                  { backgroundColor: this.state.fee === this.state.networkTransactionFees.slow ? '#d2f8d6' : '#FFFFFF' },
                ])}
                onPress={() =>
                  this.setState({ fee: this.state.networkTransactionFees.slow, isFeeCustom: false, isFeeSelectionModalVisible: false })
                }
              >
                <Text style={styles.feeText}>
                  {loc.formatBalance(
                    parseInt(this.state.networkTransactionFees.slow * 100000000).toFixed(0),
                    this.state.fromWallet.preferredBalanceUnit,
                    true,
                  )}
                </Text>
                <Text style={styles.feeTextReadable}>Slow</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={this.presentCustomFeeAlert} style={{ marginVertical: 16 }}>
                <Text style={{ textAlign: 'center', fontSize: 16, fontWeight: '600' }}>Custom</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      );
    }
  };

  presentCustomFeeAlert = () => {
    prompt(
      'Fees',
      'Satoshis Per Byte',
      [
        { text: 'Cancel', onPress: () => console.log('Cancel'), style: 'cancel' },
        {
          text: 'OK',
          onPress: text => {
            if (text > 0) {
              this.setState({ fee: text.replace('.', '').slice(0, 9), isFeeCustom: true, isFeeSelectionModalVisible: false });
            } else {
              this.setState({ isFeeSelectionModalVisible: false });
            }
          },
        },
      ],
      {
        type: 'plain-text',
        cancelable: true,
        defaultValue: this.state.isFeeCustom ? this.state.fee : 1,
        placeholder: '1 sat/byte',
      },
    );
  };

  feeFetchFailedAlert = () => {
    Alert.alert('Fees', 'An error was encountered when trying to fetch current network fees. Would you like to try again?', [
      { text: 'Cancel', onPress: () => console.log('Cancel'), style: 'cancel' },
      {
        text: 'OK',
        style: 'default',
        onPress: () => this.fetchNetworkFees(),
      },
    ]);
  };

  renderCreateButton = () => {
    return (
      <View style={{ marginHorizontal: 56, marginVertical: 16, alignContent: 'center', backgroundColor: '#FFFFFF', minHeight: 44 }}>
        {this.state.isLoading ? (
          <ActivityIndicator />
        ) : (
          <BlueButton onPress={() => this.createTransaction()} title={loc.send.details.create} />
        )}
      </View>
    );
  };

  renderWalletSelectionButton = () => {
    if (this.state.renderWalletSelectionButtonHidden) return;
    return (
      <View style={{ marginBottom: 24, alignItems: 'center' }}>
        {!this.state.isLoading && (
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 16 }}
            onPress={() =>
              this.props.navigation.navigate('SelectWallet', { onWalletSelect: this.onWalletSelect, chainType: Chain.ONCHAIN })
            }
          >
            <Text style={{ color: '#9aa0aa', fontSize: 14, paddingHorizontal: 16, alignSelf: 'center' }}>
              {loc.wallets.select_wallet.toLowerCase()}
            </Text>
            <Icon name="angle-right" size={22} type="font-awesome" color="#9aa0aa" />
          </TouchableOpacity>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 4 }}>
          <Text style={{ color: '#0c2550', fontSize: 14 }}>{this.state.fromWallet.getLabel()}</Text>
          <Text style={{ color: '#0c2550', fontSize: 14, fontWeight: '600', marginLeft: 8, marginRight: 4 }}>
            {loc.formatBalanceWithoutSuffix(this.state.fromWallet.getBalance(), BitcoinUnit.BTC, false)}
          </Text>
          <Text style={{ color: '#0c2550', fontSize: 11, fontWeight: '600', textAlignVertical: 'bottom', marginTop: 2 }}>
            {BitcoinUnit.BTC}
          </Text>
        </View>
      </View>
    );
  };

  renderFeeFetchStatusComponent = () => {
    if (this.state.feeFetchStatus === NetworkTransactionFeeStatus.FAILED) {
      return (
        <TouchableOpacity onPress={this.feeFetchFailedAlert} style={{ marginLeft: 20 }}>
          <Icon name="exclamation-circle" size={22} type="font-awesome" color="#FF0000" />
        </TouchableOpacity>
      );
    } else if (this.state.feeFetchStatus === NetworkTransactionFeeStatus.FETCHING) {
      return <ActivityIndicator style={{ marginLeft: 20 }} />;
    }
    return <React.Fragment />;
  };

  render() {
    if (this.state.isLoading || typeof this.state.fromWallet === 'undefined') {
      return (
        <View style={{ flex: 1, paddingTop: 20 }}>
          <BlueLoading />
        </View>
      );
    }
    return (
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <View style={{ flex: 1, justifyContent: 'space-between' }}>
          <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
            <KeyboardAvoidingView behavior="position">
              <BlueBitcoinAmount
                isLoading={this.state.isLoading}
                amount={this.state.amount.toString()}
                onChangeText={text => this.setState({ amount: text })}
                inputAccessoryViewID={BlueDismissKeyboardInputAccessory.InputAccessoryViewID}
              />
              <BlueAddressInput
                onChangeText={text => {
                  if (!this.processBIP70Invoice(text)) {
                    this.setState({
                      address: text.trim().replace('bitcoin:', ''),
                      isLoading: false,
                      bip70TransactionExpiration: null,
                    });
                  } else {
                    try {
                      const { address, amount, memo } = this.decodeBitcoinUri(text);
                      this.setState({
                        address: address || this.state.address,
                        amount: amount || this.state.amount,
                        memo: memo || this.state.memo,
                        isLoading: false,
                        bip70TransactionExpiration: null,
                      });
                    } catch (_) {
                      this.setState({ address: text.trim(), isLoading: false, bip70TransactionExpiration: null });
                    }
                  }
                }}
                onBarScanned={this.processAddressData}
                address={this.state.address}
                isLoading={this.state.isLoading}
                inputAccessoryViewID={BlueDismissKeyboardInputAccessory.InputAccessoryViewID}
              />
              <View
                hide={!this.state.showMemoRow}
                style={{
                  flexDirection: 'row',
                  borderColor: '#d2d2d2',
                  borderBottomColor: '#d2d2d2',
                  borderWidth: 1.0,
                  borderBottomWidth: 0.5,
                  backgroundColor: '#f5f5f5',
                  minHeight: 44,
                  height: 44,
                  marginHorizontal: 20,
                  alignItems: 'center',
                  marginVertical: 8,
                  borderRadius: 4,
                }}
              >
                <TextInput
                  onChangeText={text => this.setState({ memo: text })}
                  placeholder={loc.send.details.note_placeholder}
                  value={this.state.memo}
                  numberOfLines={1}
                  style={{ flex: 1, marginHorizontal: 8, minHeight: 33 }}
                  editable={!this.state.isLoading}
                  onSubmitEditing={Keyboard.dismiss}
                  inputAccessoryViewID={BlueDismissKeyboardInputAccessory.InputAccessoryViewID}
                />
              </View>
              <View style={{ flexDirection: 'row', marginHorizontal: 20 }}>
                <TouchableOpacity
                  onPress={() =>
                    typeof this.state.networkTransactionFees !== 'object'
                      ? this.presentCustomFeeAlert()
                      : this.setState({ isFeeSelectionModalVisible: true })
                  }
                  disabled={this.state.isLoading}
                  style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-between' }}
                >
                  <Text style={{ color: '#81868e', fontSize: 14, alignSelf: 'center' }}>Fee</Text>
                  <View
                    style={{
                      backgroundColor: '#d2f8d6',
                      minWidth: 40,
                      height: 25,
                      borderRadius: 4,
                      justifyContent: 'space-between',
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 10,
                    }}
                  >
                    <Text style={{ color: '#37c0a1', marginBottom: 0, marginRight: 4, textAlign: 'right' }}>{this.feeText()}</Text>
                  </View>
                </TouchableOpacity>
                {this.renderFeeFetchStatusComponent()}
              </View>
              {this.renderCreateButton()}
              {this.renderFeeSelectionModal()}
            </KeyboardAvoidingView>
          </View>
          <BlueDismissKeyboardInputAccessory />
          {this.renderWalletSelectionButton()}
        </View>
      </TouchableWithoutFeedback>
    );
  }
}

const styles = StyleSheet.create({
  modalContent: {
    backgroundColor: '#FFFFFF',
    padding: 22,
    justifyContent: 'center',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderColor: 'rgba(0, 0, 0, 0.1)',
    minHeight: 340,
    height: 340,
    paddingBottom: 16,
  },
  bottomModal: {
    justifyContent: 'flex-end',
    margin: 0,
  },
  feeRow: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    paddingHorizontal: 8,
    marginVertical: 8,
    justifyContent: 'center',
  },
  feeText: {
    color: '#37c0a1',
    fontSize: 24,
    fontWeight: '600',
  },
  feeTextReadable: {
    color: '#37c0a1',
    fontSize: 18,
  },
});

SendDetails.propTypes = {
  navigation: PropTypes.shape({
    pop: PropTypes.func,
    goBack: PropTypes.func,
    navigate: PropTypes.func,
    getParam: PropTypes.func,
    state: PropTypes.shape({
      params: PropTypes.shape({
        amount: PropTypes.number,
        address: PropTypes.string,
        fromAddress: PropTypes.string,
        satoshiPerByte: PropTypes.string,
        fromSecret: PropTypes.fromSecret,
        fromWallet: PropTypes.fromWallet,
        memo: PropTypes.string,
        uri: PropTypes.string,
      }),
    }),
  }),
};
