import _ from 'lodash';
import ErrorBanner from './ErrorBanner.jsx';
import PageHeader from './PageHeader.jsx';
import Percentage from './util/Percentage.js';
import PropTypes from 'prop-types';
import React from 'react';
import TapQueryCliCmd from './TapQueryCliCmd.jsx';
import TapQueryForm from './TapQueryForm.jsx';
import TopEventTable from './TopEventTable.jsx';
import { withContext } from './util/AppContext.jsx';
import { defaultMaxRps, processTapEvent } from './util/TapUtils.js';
import './../../css/tap.css';

class Top extends React.Component {
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
      tapResultsById: {},
      topEventIndex: {},
      error: null,
      resourcesByNs: {},
      authoritiesByNs: {},
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
      maxRowsToStore: 40,
      awaitingWebSocketConnection: false,
      tapRequestInProgress: false,
      pollingInterval: 10000,
      pendingRequests: false
    };
  }

  componentDidMount() {
    this.startServerPolling();
  }

  componentWillUnmount() {
    if (this.ws) {
      this.ws.close(1000);
    }
    this.stopTapStreaming();
    this.stopServerPolling();
  }

  onWebsocketOpen = () => {
    let query = _.cloneDeep(this.state.query);
    query.maxRps = parseFloat(query.maxRps);

    this.ws.send(JSON.stringify({
      id: "tap-web",
      ...query
    }));
    this.setState({
      awaitingWebSocketConnection: false,
      error: null
    });
  }

  onWebsocketRecv = e => {
    this.indexTapResult(e.data);
  }

  onWebsocketClose = e => {
    this.stopTapStreaming();

    if (!e.wasClean) {
      this.setState({
        error: {
          error: `Websocket [${e.code}] ${e.reason}`
        }
      });
    }
  }

  onWebsocketError = e => {
    this.setState({
      error: { error: e.message }
    });

    this.stopTapStreaming();
  }

  getResourcesByNs(rsp) {
    let statTables = _.get(rsp, [0, "ok", "statTables"]);
    let authoritiesByNs = {};
    let resourcesByNs = _.reduce(statTables, (mem, table) => {
      _.map(table.podGroup.rows, row => {
        if (!mem[row.resource.namespace]) {
          mem[row.resource.namespace] = [];
          authoritiesByNs[row.resource.namespace] = [];
        }

        switch (row.resource.type.toLowerCase()) {
          case "service":
            break;
          case "authority":
            authoritiesByNs[row.resource.namespace].push(row.resource.name);
            break;
          default:
            mem[row.resource.namespace].push(`${row.resource.type}/${row.resource.name}`);
        }
      });
      return mem;
    }, {});
    return {
      authoritiesByNs,
      resourcesByNs
    };
  }

  parseTapResult = data => {
    let d = processTapEvent(data);

    if (d.eventType === "rsp") {
      d.success = parseInt(d.http.responseInit.httpStatus, 10) < 500;
    } else if (d.eventType === "end") {
      d.latency = parseFloat(d.http.responseEnd.sinceRequestInit.replace("s", ""));
      d.completed = true;
    }

    return d;
  }

  topEventKey = event => {
    return [event.source.str, event.destination.str, event.http.requestInit.path].join("_");
  }

  initialTopResult(d, eventKey) {
    return {
      count: 1,
      best: d.end.latency,
      worst: d.end.latency,
      last: d.end.latency,
      success: !d.rsp.success ? 0 : 1,
      failure: !d.rsp.success ? 1 : 0,
      successRate: !d.rsp.success ? new Percentage(0, 1) : new Percentage(1, 1),
      source: d.req.source.str,
      destination: d.req.destination.str,
      path: d.req.http.requestInit.path,
      key: eventKey,
      lastUpdated: Date.now()
    };
  }

  incrementTopResult(d, result) {
    result.count++;
    if (!d.rsp.success) {
      result.failure++;
    } else {
      result.success++;
    }
    result.successRate = new Percentage(result.success, result.success + result.failure);

    result.last = d.end.latency;
    if (d.end.latency < result.best) {
      result.best = d.end.latency;
    }
    if (d.end.latency > result.worst) {
      result.worst = d.end.latency;
    }

    result.lastUpdated = Date.now();
  }

  indexTopResult = (d, topResults) => {
    let eventKey = this.topEventKey(d.req);

    if (!topResults[eventKey]) {
      topResults[eventKey] = this.initialTopResult(d, eventKey);
    } else {
      this.incrementTopResult(d, topResults[eventKey]);
    }

    if (_.size(topResults) > this.state.maxRowsToStore) {
      this.deleteOldestIndexedResult(topResults);
    }

    return topResults;
  }

  indexTapResult = data => {
    // keep an index of tap results by id until the request is complete.
    // when the request has completed, add it to the aggregated Top counts and
    // discard the individual tap result
    let resultIndex = this.state.tapResultsById;
    let d = this.parseTapResult(data);

    if (_.isNil(resultIndex[d.id])) {
      // don't let tapResultsById grow unbounded
      if (_.size(resultIndex) > this.state.maxRowsToStore) {
        this.deleteOldestIndexedResult(resultIndex);
      }

      resultIndex[d.id] = {};
    }
    resultIndex[d.id][d.eventType] = d;

    // assumption: requests of a given id all share the same high level metadata
    resultIndex[d.id]["base"] = d;
    resultIndex[d.id].lastUpdated = Date.now();

    let topIndex = this.state.topEventIndex;
    if (d.completed) {
      // only add results into top if the request has completed
      // we can also now delete this result from the Tap result index
      topIndex = this.indexTopResult(resultIndex[d.id], topIndex);
      delete resultIndex[d.id];
    }

    this.setState({
      tapResultsById: resultIndex,
      topEventIndex: topIndex
    });
  }

  deleteOldestIndexedResult = resultIndex => {
    let oldest = Date.now();
    let oldestId = "";

    _.each(resultIndex, (res, id) => {
      if (res.lastUpdated < oldest) {
        oldest = res.lastUpdated;
        oldestId = id;
      }
    });

    delete resultIndex[oldestId];
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
      awaitingWebSocketConnection: true,
      tapRequestInProgress: true,
      tapResultsById: {},
      topEventIndex: {}
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
      tapRequestInProgress: false,
      awaitingWebSocketConnection: false
    });
  }

  handleTapStart = e => {
    e.preventDefault();
    this.startTapSteaming();
  }

  handleTapStop = () => {
    this.ws.close(1000);
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
        let { resourcesByNs, authoritiesByNs } = this.getResourcesByNs(rsp);

        this.setState({
          resourcesByNs,
          authoritiesByNs,
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
      error: e
    });
  }

  updateQuery = query => {
    this.setState({
      query
    });
  }

  render() {
    let tableRows = _.values(this.state.topEventIndex);

    return (
      <div>
        {!this.state.error ? null :
        <ErrorBanner message={this.state.error} onHideMessage={() => this.setState({ error: null })} />}

        <PageHeader header="Top" />
        <TapQueryForm
          enableAdvancedForm={false}
          tapRequestInProgress={this.state.tapRequestInProgress}
          awaitingWebSocketConnection={this.state.awaitingWebSocketConnection}
          handleTapStart={this.handleTapStart}
          handleTapStop={this.handleTapStop}
          resourcesByNs={this.state.resourcesByNs}
          authoritiesByNs={this.state.authoritiesByNs}
          updateQuery={this.updateQuery}
          query={this.state.query} />

        <TapQueryCliCmd cmdName="top" query={this.state.query} />

        <TopEventTable tableRows={tableRows} />
      </div>
    );
  }
}

export default withContext(Top);