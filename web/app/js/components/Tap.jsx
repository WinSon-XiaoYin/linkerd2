import _ from 'lodash';
import ErrorBanner from './ErrorBanner.jsx';
import PageHeader from './PageHeader.jsx';
import PropTypes from 'prop-types';
import React from 'react';
import { withContext } from './util/AppContext.jsx';
import {
  AutoComplete,
  Button,
  Col,
  Form,
  Icon,
  Input,
  Row,
  Select
} from 'antd';
import './../../css/tap.css';

const colSpan = 5;
const rowGutter = 16;
const httpMethods = ["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"];
const defaultMaxRps = 1.0;
class Tap extends React.Component {
  static propTypes = {
    api: PropTypes.shape({
      PrefixedLink: PropTypes.func.isRequired,
    }).isRequired,
    pathPrefix: PropTypes.string.isRequired
  }

  constructor(props) {
    super(props);
    this.api = this.props.api;
    this.loadFromServer = this.loadFromServer.bind(this);

    this.state = {
      error: "",
      messages: [],
      resourcesByNs: {},
      query: {
        resource: "",
        namespace: "",
        toResource: "",
        toNamespace: "",
        method: "",
        path: "",
        scheme: "",
        authority: "",
        maxRps: defaultMaxRps
      },
      autocomplete: {
        namespace: [],
        resource: [],
        toNamespace: [],
        toResource: [],
      },
      maxLinesToDisplay: 40,
      awaitingWebSocketConnection: false,
      webSocketRequestSent: false,
      showAdvancedForm: false,
      pollingInterval: 10000,
      pendingRequests: false
    };
  }

  componentDidMount() {
    this.startServerPolling();
  }

  componentWillUnmount() {
    this.ws.close(1000);
    this.stopTapStreaming();
    this.stopServerPolling();
  }

  onWebsocketOpen = () => {
    let query = this.state.query;
    query.maxRps = parseFloat(query.maxRps) || defaultMaxRps;

    this.ws.send(JSON.stringify({
      id: "tap-web",
      ...query
    }));
    this.setState({
      webSocketRequestSent: true,
      awaitingWebSocketConnection: false,
      error: ""
    });
  }

  onWebsocketRecv = e => {
    this.setState({
      messages: _(this.state.messages)
        .push(e.data)
        .takeRight(this.state.maxLinesToDisplay)
        .value()
    });
  }

  onWebsocketClose = e => {
    if (!e.wasClean) {
      this.setState({
        error: `Websocket [${e.code}] ${e.reason}`
      });
    }

    this.stopTapStreaming();
  }

  onWebsocketError = e => {
    this.setState({
      error: e.message
    });

    this.stopTapStreaming();
  }

  getResourcesByNs(rsp) {
    let statTables = _.get(rsp, [0, "ok", "statTables"]);
    return _.reduce(statTables, (mem, table) => {
      _.map(table.podGroup.rows, row => {
        if (!mem[row.resource.namespace]) {
          mem[row.resource.namespace] = [];
        }

        if (row.resource.type.toLowerCase() !== "service") {
          mem[row.resource.namespace].push(`${row.resource.type}/${row.resource.name}`);
        }
      });
      return mem;
    }, {});
  }

  startServerPolling() {
    this.loadFromServer();
    this.timerId = window.setInterval(this.loadFromServer, this.state.pollingInterval);
  }

  stopServerPolling() {
    window.clearInterval(this.timerId);
    this.api.cancelCurrentRequests();
  }

  startTapSteaming() {
    this.setState({
      messages: [],
      awaitingWebSocketConnection: true
    });

    let protocol = window.location.protocol === "https:" ? "wss" : "ws";
    let tapWebSocket = `${protocol}://${window.location.host}${this.props.pathPrefix}/api/tap`;

    this.ws = new WebSocket(tapWebSocket);
    this.ws.onmessage = this.onWebsocketRecv;
    this.ws.onclose = this.onWebsocketClose;
    this.ws.onopen = this.onWebsocketOpen;
    this.ws.onerror = this.onWebsocketError;
  }

  stopTapStreaming() {
    this.setState({
      webSocketRequestSent: false,
      awaitingWebSocketConnection: false
    });
  }

  toggleAdvancedForm = show => {
    this.setState({
      showAdvancedForm: show
    });
  }

  handleTapStart = e => {
    e.preventDefault();
    this.startTapSteaming();
  }

  handleTapStop = () => {
    this.ws.close(1000);
  }

  handleFormChange = (name, scopeResource) => {
    let state = {
      query: this.state.query,
      autocomplete: this.state.autocomplete
    };

    return formVal => {
      state.query[name] = formVal;
      if (!_.isNil(scopeResource)) {
        // scope the available typeahead resources to the selected namespace
        state.autocomplete[scopeResource] = this.state.resourcesByNs[formVal];
      }

      this.setState(state);
    };
  }

  handleFormEvent = name => {
    let state = {
      query: this.state.query
    };

    return event => {
      state.query[name] = event.target.value;
      this.setState(state);
    };
  }

  autoCompleteData = name => {
    return _(this.state.autocomplete[name])
      .filter(d => d.indexOf(this.state.query[name]) !== -1)
      .sortBy()
      .value();
  }

  loadFromServer() {
    if (this.state.pendingRequests) {
      return; // don't make more requests if the ones we sent haven't completed
    }
    this.setState({
      pendingRequests: true
    });

    let url = "/api/tps-reports?resource_type=all&all_namespaces=true";
    this.api.setCurrentRequests([this.api.fetchMetrics(url)]);
    this.serverPromise = Promise.all(this.api.getCurrentPromises())
      .then(rsp => {
        let resourcesByNs = this.getResourcesByNs(rsp);
        let namespaces = _.sortBy(_.keys(resourcesByNs));
        let resourceNames = resourcesByNs[this.state.query.namespace] ||
          _.uniq(_.flatten(_.values(resourcesByNs)));
        let toResourceNames = resourcesByNs[this.state.query.toNamespace] ||
          _.uniq(_.flatten(_.values(resourcesByNs)));

        this.setState({
          resourcesByNs,
          autocomplete: {
            namespace: namespaces,
            resource: resourceNames,
            toNamespace: namespaces,
            toResource: toResourceNames
          },
          pendingRequests: false
        });
      })
      .catch(this.handleApiError);
  }

  handleApiError = e => {
    if (e.isCanceled) {
      return;
    }

    this.setState({
      pendingRequests: false,
      error: `Error getting data from server: ${e.message}`
    });
  }

  renderTapForm = () => {
    return (
      <Form>
        <Row gutter={rowGutter}>
          <Col span={colSpan}>
            <Form.Item>
              <Select
                showSearch
                allowClear
                placeholder="Namespace"
                optionFilterProp="children"
                onChange={this.handleFormChange("namespace", "resource")}>
                {
                  _.map(this.state.autocomplete.namespace, (n, i) => (
                    <Select.Option key={`ns-dr-${i}`} value={n}>{n}</Select.Option>
                  ))
                }
              </Select>
            </Form.Item>
          </Col>

          <Col span={colSpan}>
            <Form.Item>
              <AutoComplete
                dataSource={this.autoCompleteData("resource")}
                onSelect={this.handleFormChange("resource")}
                onSearch={this.handleFormChange("resource")}
                placeholder="Resource" />
            </Form.Item>
          </Col>

          <Col span={colSpan}>
            <Form.Item>
              {
                this.state.webSocketRequestSent ?
                  <Button type="primary" className="tap-stop" onClick={this.handleTapStop}>Stop</Button> :
                  <Button type="primary" className="tap-start" onClick={this.handleTapStart}>Start</Button>
              }
            </Form.Item>
          </Col>
        </Row>

        <Button
          className="tap-form-toggle"
          onClick={() => this.toggleAdvancedForm(!this.state.showAdvancedForm)}>
          { this.state.showAdvancedForm ?
            "Hide filters" : "Show more filters" } <Icon type={this.state.showAdvancedForm ? 'up' : 'down'} />
        </Button>

        { !this.state.showAdvancedForm ? null : this.renderAdvancedTapForm() }
      </Form>
    );
  }

  renderAdvancedTapForm = () => {
    return (
      <React.Fragment>
        <Row gutter={rowGutter}>
          <Col span={colSpan}>
            <Form.Item>
              <Select
                showSearch
                allowClear
                placeholder="To Namespace"
                optionFilterProp="children"
                onChange={this.handleFormChange("toNamespace", "toResource")}>
                {
                  _.map(this.state.autocomplete.toNamespace, (n, i) => (
                    <Select.Option key={`ns-dr-${i}`} value={n}>{n}</Select.Option>
                  ))
                }
              </Select>
            </Form.Item>
          </Col>

          <Col span={colSpan}>
            <Form.Item>
              <AutoComplete
                dataSource={this.autoCompleteData("toResource")}
                onSelect={this.handleFormChange("toResource")}
                onSearch={this.handleFormChange("toResource")}
                placeholder="To Resource" />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={rowGutter}>
          <Col span={2 * colSpan}>
            <Form.Item
              extra="Display requests with this :authority">
              <Input placeholder="Authority" onChange={this.handleFormEvent("authority")} />
            </Form.Item>
          </Col>

          <Col span={2 * colSpan}>
            <Form.Item
              extra="Display requests with paths that start with this prefix">
              <Input placeholder="Path" onChange={this.handleFormEvent("path")} />
            </Form.Item>
          </Col>

        </Row>

        <Row gutter={rowGutter}>
          <Col span={colSpan}>
            <Form.Item
              extra="Display requests with this scheme">
              <Input placeholder="Scheme" onChange={this.handleFormEvent("scheme")} />
            </Form.Item>
          </Col>

          <Col span={colSpan}>
            <Form.Item
              extra="Maximum requests per second to tap">
              <Input
                defaultValue={defaultMaxRps}
                placeholder="Max RPS"
                onChange={this.handleFormEvent("maxRps")} />
            </Form.Item>
          </Col>

          <Col span={colSpan}>
            <Form.Item
              extra="Display requests with this HTTP method">
              <Select
                allowClear
                placeholder="HTTP method"
                onChange={this.handleFormChange("method")}>
                {
                  _.map(httpMethods, m =>
                    <Select.Option key={`method-select-${m}`} value={m}>{m}</Select.Option>
                  )
                }
              </Select>
            </Form.Item>
          </Col>
        </Row>
      </React.Fragment>
    );
  }

  renderCurrentQuery = () => {
    let emptyVals =  _.countBy(_.values(this.state.query), v => _.isEmpty(v));

    return (
      <div className="tap-query">
        <code>
          { !emptyVals.false || emptyVals.false === 1 ? null :
          <div>
            Current query:
            {
              _.map(this.state.query, (query, queryName) => {
                if (query === "") {
                  return null;
                }
                return <div key={queryName}>{queryName}: {query}</div>;
              })
            }
          </div>
          }
        </code>
      </div>
    );
  }

  render() {
    return (
      <div>
        {!this.state.error ? null :
        <ErrorBanner message={this.state.error} onHideMessage={() => this.setState({ error: "" })} />}

        <PageHeader header="Tap" />
        {this.renderTapForm()}
        {this.renderCurrentQuery()}

        <div className="tap-display">
          <code>
            { this.state.awaitingWebSocketConnection ?
              <div><Icon type="loading" /> Starting tap query...</div> : null }
            { _.isEmpty(this.state.messages) && this.state.webSocketRequestSent
              && !this.state.awaitingWebSocketConnection
              ? <div>No messages to display</div> : null }
            { _.map(this.state.messages, (m, i) => <div key={`message-${i}`}>{m}</div>)}
          </code>
        </div>
      </div>
    );
  }
}

export default withContext(Tap);